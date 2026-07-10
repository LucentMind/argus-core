import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
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
})
