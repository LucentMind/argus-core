import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConnectorRegistry } from '../connectors'
import { SecretStore, type SecretCrypto } from '../secrets'
import { McpService } from '../mcp'

const FIXTURE = fileURLToPath(new URL('./fixtures/fixture-mcp.mjs', import.meta.url))

const fakeCrypto = (): SecretCrypto => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').slice(4)
})

let tmp: string, argusHome: string, registry: ConnectorRegistry, secrets: SecretStore

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-mcpdisc-'))
  argusHome = path.join(tmp, 'home')
  registry = new ConnectorRegistry(argusHome)
  secrets = new SecretStore(argusHome, fakeCrypto())
})

afterEach(() => {
  registry.close()
  secrets.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('McpService discovery against the fixture stdio server', () => {
  it('probe connects, lists, classifies, caches, tears down', async () => {
    registry.patch({
      fix: { kind: 'stdio', config: { command: process.execPath, args: [FIXTURE] } }
    })
    const svc = new McpService({ registry, secrets, toolRisk: () => ({}) })
    const r = await svc.probe('fix')
    expect(r.ok).toBe(true)
    expect(r.tools!.map((t) => `${t.name}:${t.risk}`).sort()).toEqual([
      'add_comment:medium',
      'delete_ticket:high',
      'frobnicate:medium',
      'get_ticket:low'
    ])
    expect(svc.runtimeStates().fix).toMatchObject({ state: 'connected', toolCount: 4 })
    // cache persisted — a fresh registry sees it without reconnecting
    const reloaded = new ConnectorRegistry(argusHome)
    expect(reloaded.get().fix.lastDiscovered?.tools).toHaveLength(4)
    reloaded.close()
  }, 30000)

  it('tool-risk overrides apply at discovery time', async () => {
    registry.patch({
      fix: { kind: 'stdio', config: { command: process.execPath, args: [FIXTURE] } }
    })
    const svc = new McpService({ registry, secrets, toolRisk: () => ({ 'fix/frobnicate': 'low' }) })
    const r = await svc.probe('fix')
    expect(r.tools!.find((t) => t.name === 'frobnicate')!.risk).toBe('low')
  }, 30000)

  it('$secret env refs are resolved into the child process; missing secret refuses the probe', async () => {
    registry.patch({
      fix: {
        kind: 'stdio',
        config: {
          command: process.execPath,
          args: [FIXTURE],
          env: { FIXTURE_REQUIRE_TOKEN: '1', FIXTURE_TOKEN: { $secret: 'fix-token' } }
        }
      }
    })
    const svc = new McpService({ registry, secrets, toolRisk: () => ({}) })
    const denied = await svc.probe('fix')
    expect(denied.ok).toBe(false)
    expect(denied.error).toMatch(/missing secrets: fix-token/)
    expect(svc.runtimeStates().fix).toMatchObject({ state: 'error' })
    secrets.set('fix-token', 'sesame')
    const granted = await svc.probe('fix')
    expect(granted.ok).toBe(true)
    expect(svc.runtimeStates().fix).toMatchObject({ state: 'connected' })
  }, 30000)

  it('broken command → error state with reason; unknown id and unsupported kind refuse cleanly', async () => {
    registry.patch({
      bad: {
        kind: 'stdio',
        config: { command: process.execPath, args: ['-e', 'process.exit(1)'] }
      },
      odd: { kind: 'future-kind', config: {} }
    })
    const svc = new McpService({ registry, secrets, toolRisk: () => ({}) })
    expect((await svc.probe('bad')).ok).toBe(false)
    expect(svc.runtimeStates().bad).toMatchObject({ state: 'error' })
    expect((await svc.probe('ghost')).error).toMatch(/unknown connector/)
    expect((await svc.probe('odd')).error).toMatch(/unsupported kind/)
  }, 30000)

  it('probe against a hanging server resolves with a timeout error (client torn down)', async () => {
    // spawns fine but never speaks MCP — connect() would await initialize forever
    registry.patch({
      hang: {
        kind: 'stdio',
        config: { command: process.execPath, args: ['-e', 'setInterval(()=>{},1e3)'] }
      }
    })
    const svc = new McpService({ registry, secrets, toolRisk: () => ({}), probeTimeoutMs: 500 })
    const r = await svc.probe('hang')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/timed out/)
    expect(svc.runtimeStates().hang).toMatchObject({ state: 'error' })
  }, 10000)

  it('HTTP 401 → needs-auth via the structured error code (message carries no "401")', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 401
      res.end() // empty body: the SDK error message contains no "401"/"unauthorized" text
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      registry.patch({ web: { kind: 'http', config: { url: `http://127.0.0.1:${port}/mcp` } } })
      const svc = new McpService({ registry, secrets, toolRisk: () => ({}) })
      const r = await svc.probe('web')
      expect(r.ok).toBe(false)
      expect(svc.runtimeStates().web).toMatchObject({ state: 'needs-auth' })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 30000)
})

describe('composeForSession', () => {
  it('composes enabled connectors, resolves secrets, skips the rest with reasons', () => {
    secrets.set('hdr-token', 'tok123')
    registry.patch({
      fix: {
        kind: 'stdio',
        config: { command: 'node', args: ['s.mjs'], env: { T: { $secret: 'hdr-token' } } }
      },
      remote: {
        kind: 'http',
        config: {
          url: 'https://mcp.example.com/v1',
          headers: { 'X-Api-Key': { $secret: 'hdr-token' } }
        }
      },
      ssehost: { kind: 'http', config: { url: 'https://sse.example.com/v1', transport: 'sse' } },
      off: { kind: 'stdio', enabled: false, config: { command: 'x' } },
      odd: { kind: 'future-kind', config: {} },
      argus: { kind: 'stdio', config: { command: 'evil' } }, // reserved name
      nosecret: { kind: 'http', config: { url: 'https://x', headers: { K: { $secret: 'gone' } } } }
    })
    const svc = new McpService({ registry, secrets, toolRisk: () => ({}) })
    svc.markError('remote-broken', 'noop') // marking an unknown id must not throw
    const { servers, skipped } = svc.composeForSession()
    expect(servers.fix).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['s.mjs'],
      env: { T: 'tok123' }
    })
    expect(servers.remote).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/v1',
      headers: { 'X-Api-Key': 'tok123' }
    })
    expect(servers.ssehost).toEqual({ type: 'sse', url: 'https://sse.example.com/v1', headers: {} })
    expect(servers.off).toBeUndefined() // disabled: silent (user choice, not an error)
    expect(servers.argus).toBeUndefined()
    expect(skipped).toContainEqual({ instanceId: 'argus', reason: 'reserved instance id' })
    expect(skipped).toContainEqual({ instanceId: 'odd', reason: 'unsupported kind: future-kind' })
    expect(skipped.find((s) => s.instanceId === 'nosecret')?.reason).toMatch(
      /missing secrets: gone/
    )
  })

  it('non-string plain env/header values (hand-edited JSON) are coerced to strings', () => {
    registry.patch({
      numenv: {
        kind: 'stdio',
        config: { command: 'node', env: { PORT: 8080, DEBUG: true } }
      },
      numhdr: {
        kind: 'http',
        config: { url: 'https://x.example/v1', headers: { 'X-Retries': 3 } }
      }
    })
    const svc = new McpService({ registry, secrets, toolRisk: () => ({}) })
    const { servers, skipped } = svc.composeForSession()
    expect(skipped).toEqual([])
    expect((servers.numenv as { env: Record<string, string> }).env).toEqual({
      PORT: '8080',
      DEBUG: 'true'
    })
    expect((servers.numhdr as { headers: Record<string, string> }).headers).toEqual({
      'X-Retries': '3'
    })
  })

  it('error-state connectors are skipped; oauth connectors without a token are skipped and marked needs-auth', () => {
    registry.patch({
      dead: { kind: 'stdio', config: { command: 'x' } },
      rovo: {
        kind: 'http',
        config: { url: 'https://mcp.atlassian.com/v1/sse', transport: 'sse', oauth: true }
      }
    })
    const svc = new McpService({
      registry,
      secrets,
      toolRisk: () => ({}),
      oauth: { accessToken: () => null, refresh: async () => false, status: () => 'not-authorized' }
    })
    svc.markError('dead', 'spawn failed')
    const { servers, skipped } = svc.composeForSession()
    expect(servers.dead).toBeUndefined()
    expect(skipped).toContainEqual({ instanceId: 'dead', reason: 'spawn failed' })
    expect(servers.rovo).toBeUndefined()
    expect(skipped.find((s) => s.instanceId === 'rovo')?.reason).toMatch(/OAuth/)
    expect(svc.runtimeStates().rovo).toEqual({ state: 'needs-auth' })
  })

  it('a connector already marked needs-auth (e.g. from a prior 401 probe) is skipped with the auth-card reason', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 401
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      registry.patch({ web: { kind: 'http', config: { url: `http://127.0.0.1:${port}/mcp` } } })
      const svc = new McpService({ registry, secrets, toolRisk: () => ({}) })
      await svc.probe('web') // observes the 401 and marks runtime state needs-auth
      expect(svc.runtimeStates().web).toMatchObject({ state: 'needs-auth' })
      const { servers, skipped } = svc.composeForSession()
      expect(servers.web).toBeUndefined()
      expect(skipped.find((s) => s.instanceId === 'web')?.reason).toMatch(/needs authorization/)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 30000)

  it('clearRuntime after a successful authorize releases the needs-auth latch — compose includes the connector', () => {
    registry.patch({
      rovo: {
        kind: 'http',
        config: { url: 'https://mcp.atlassian.com/v1/sse', transport: 'sse', oauth: true }
      }
    })
    let token: string | null = null
    const svc = new McpService({
      registry,
      secrets,
      toolRisk: () => ({}),
      oauth: {
        accessToken: () => token,
        refresh: async () => token != null,
        status: () => (token != null ? 'authorized' : 'not-authorized')
      }
    })
    // first compose with no token sets the needs-auth latch
    expect(svc.composeForSession().servers.rovo).toBeUndefined()
    expect(svc.runtimeStates().rovo).toEqual({ state: 'needs-auth' })
    // the user authorizes: token now valid — but the latch alone still skips
    token = 'live-token'
    expect(svc.composeForSession().servers.rovo).toBeUndefined()
    // the connectors:oauth success path clears the latch → compose includes it
    svc.clearRuntime('rovo')
    const { servers, skipped } = svc.composeForSession()
    expect(servers.rovo).toEqual({
      type: 'sse',
      url: 'https://mcp.atlassian.com/v1/sse',
      headers: { Authorization: 'Bearer live-token' }
    })
    expect(skipped).toEqual([])
  })

  it('oauth connector with a valid token gets the bearer header', () => {
    registry.patch({
      rovo: {
        kind: 'http',
        config: { url: 'https://mcp.atlassian.com/v1/sse', transport: 'sse', oauth: true }
      }
    })
    const svc = new McpService({
      registry,
      secrets,
      toolRisk: () => ({}),
      oauth: {
        accessToken: () => 'live-token',
        refresh: async () => true,
        status: () => 'authorized'
      }
    })
    const { servers, skipped } = svc.composeForSession()
    expect(servers.rovo).toEqual({
      type: 'sse',
      url: 'https://mcp.atlassian.com/v1/sse',
      headers: { Authorization: 'Bearer live-token' }
    })
    expect(skipped).toEqual([])
  })
})
