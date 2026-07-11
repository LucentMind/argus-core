import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HealthService, type HealthDeps } from '../health'
import type { HealthCheckResult } from '../../../shared/health'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-health-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const deps = (over: Partial<HealthDeps> = {}): HealthDeps => ({
  argusHome: tmp,
  binaries: () => [
    { id: 'tool-x', label: 'Tool X binary' },
    { id: 'tool-y', label: 'Tool Y CLI + env' }
  ],
  checkBinary: async (id: string) =>
    id === 'tool-x'
      ? { ok: true, detail: 'C:\\tool-x.exe · 0.3.0' }
      : { ok: true, detail: '2 checks passed' },
  agentAuth: async () => ({ ok: true, detail: 'logged in as x@y' }),
  gh: async () => ({ ok: true, detail: 'Logged in to github.com' }),
  enabledConnectors: () => [{ id: 'rovo', name: 'Atlassian Rovo' }],
  probeConnector: async () => ({ ok: true, tools: [{ name: 'get_x', risk: 'low' }] }),
  atlassianConfigured: () => false,
  atlassianCheck: async () => ({ ok: false, detail: 'unset' }),
  refsyncConfigured: () => false,
  confluenceCheck: async () => ({ ok: false, detail: 'unset' }),
  langfuseConfigured: () => false,
  langfuseCheck: async () => ({ ok: false, detail: 'unset' }),
  ...over
})

async function runAll(d: HealthDeps, ids: string[] | null = null): Promise<HealthCheckResult[]> {
  const out: HealthCheckResult[] = []
  await new HealthService(d).run(ids, (r) => out.push(r))
  return out
}

describe('HealthService', () => {
  it('rows: one row per registry binary, then static checks, then per-connector', () => {
    const rows = new HealthService(deps()).rows()
    expect(rows.map((r) => r.id)).toEqual([
      'bin:tool-x',
      'bin:tool-y',
      'gh',
      'agent',
      'data-root',
      'connector:rovo'
    ])
  })

  it('binary rows are labeled from the registry-provided label', () => {
    const rows = new HealthService(deps()).rows()
    expect(rows.find((r) => r.id === 'bin:tool-x')!.label).toBe('Tool X binary')
    expect(rows.find((r) => r.id === 'bin:tool-y')!.label).toBe('Tool Y CLI + env')
  })

  it('connector rows are labeled with the display name, falling back to the instance id', () => {
    const svc = new HealthService(
      deps({
        enabledConnectors: () => [
          { id: 'rovo', name: 'Atlassian Rovo' },
          { id: 'http-1', name: 'Langchain' },
          { id: 'bare', name: 'bare' } // no displayName configured → id
        ]
      })
    )
    const labels = svc
      .rows()
      .filter((r) => r.id.startsWith('connector:'))
      .map((r) => r.label)
    expect(labels).toEqual(['Atlassian Rovo', 'Langchain', 'bare'])
  })

  it('run(null) emits a result per row; all green with healthy deps', async () => {
    const out = await runAll(deps())
    expect(out).toHaveLength(6)
    expect(out.every((r) => r.ok)).toBe(true)
    expect(out.find((r) => r.id === 'bin:tool-x')!.detail).toContain('0.3.0')
    expect(out.find((r) => r.id === 'connector:rovo')!.detail).toContain('1 tools')
  })

  it('a failing binary row carries a fixHint; a passing one does not', async () => {
    const out = await runAll(
      deps({
        checkBinary: async (id: string) =>
          id === 'tool-x'
            ? { ok: false, detail: 'not found', fixHint: 'Install tool-x.' }
            : { ok: true, detail: '2 checks passed' }
      })
    )
    const bad = out.find((r) => r.id === 'bin:tool-x')!
    expect(bad.ok).toBe(false)
    expect(bad.fixHint).toBe('Install tool-x.')
    const good = out.find((r) => r.id === 'bin:tool-y')!
    expect(good.ok).toBe(true)
    expect(good.detail).toBe('2 checks passed')
    expect(good.fixHint).toBeUndefined()
  })

  it('failures carry detail + fixHint and never throw', async () => {
    const out = await runAll(
      deps({
        checkBinary: async () => ({ ok: false, detail: 'not found', fixHint: 'Install it.' }),
        agentAuth: async () => ({ ok: false, detail: 'not logged in' }),
        gh: async () => ({ ok: false, detail: 'gh not installed' }),
        probeConnector: async () => ({ ok: false, error: 'connect ECONNREFUSED' })
      })
    )
    expect(out.every((r) => !r.ok || r.id === 'data-root')).toBe(true)
    for (const id of ['bin:tool-x', 'bin:tool-y', 'gh', 'agent', 'connector:rovo'])
      expect(out.find((r) => r.id === id)!.fixHint).toBeTruthy()
  })

  it('run with ids filters; a throwing dep becomes a failed row', async () => {
    const out = await runAll(
      deps({
        agentAuth: async () => {
          throw new Error('probe exploded')
        }
      }),
      ['agent']
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'agent', ok: false })
    expect(out[0].detail).toContain('probe exploded')
  })

  it('a throwing checkBinary dep becomes a failed row', async () => {
    const out = await runAll(
      deps({
        checkBinary: async () => {
          throw new Error('probe exploded')
        }
      }),
      ['bin:tool-x']
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'bin:tool-x', ok: false })
    expect(out[0].detail).toContain('probe exploded')
  })

  it('data-root check writes and removes a probe file', async () => {
    const out = await runAll(deps(), ['data-root'])
    expect(out[0].ok).toBe(true)
    expect(fs.readdirSync(tmp).filter((f) => f.includes('.health-'))).toHaveLength(0)
  })

  it('adds the atlassian-rest row only when a rovo connector is configured', () => {
    const none = new HealthService(deps({ atlassianConfigured: () => false }))
    expect(none.rows().some((r) => r.id === 'atlassian-rest')).toBe(false)
    const some = new HealthService(deps({ atlassianConfigured: () => true }))
    expect(some.rows().some((r) => r.id === 'atlassian-rest')).toBe(true)
  })

  it('atlassian-rest check reports ok detail and failure fix hint', async () => {
    const results: HealthCheckResult[] = []
    const ok = new HealthService(
      deps({
        atlassianConfigured: () => true,
        atlassianCheck: async () => ({ ok: true, detail: 'authenticated as Ada' })
      })
    )
    await ok.run(['atlassian-rest'], (r) => results.push(r))
    expect(results[0]).toMatchObject({ ok: true, detail: 'authenticated as Ada' })

    results.length = 0
    const bad = new HealthService(
      deps({
        atlassianConfigured: () => true,
        atlassianCheck: async () => ({ ok: false, detail: 'HTTP 401' })
      })
    )
    await bad.run(['atlassian-rest'], (r) => results.push(r))
    expect(results[0]).toMatchObject({ ok: false, detail: 'HTTP 401' })
    expect(results[0].fixHint).toMatch(/Site URL, email, and API token/)
  })

  it('confluence-rest row appears when a space is configured and maps check results', async () => {
    const results: HealthCheckResult[] = []
    const svc = new HealthService({
      ...deps(),
      refsyncConfigured: () => true,
      confluenceCheck: async () => ({
        ok: false,
        detail: 'Atlassian rejected the API token (HTTP 401)'
      })
    })
    expect(svc.rows().map((r) => r.id)).toContain('confluence-rest')
    await svc.run(['confluence-rest'], (r) => results.push(r))
    expect(results[0].ok).toBe(false)
    expect(results[0].fixHint).toMatch(/connector/i)
  })

  it('confluence-rest row is absent with no configured spaces', () => {
    const svc = new HealthService({
      ...deps(),
      refsyncConfigured: () => false,
      confluenceCheck: async () => ({ ok: true, detail: '' })
    })
    expect(svc.rows().map((r) => r.id)).not.toContain('confluence-rest')
  })

  it('adds a langfuse row when configured and reports the check', async () => {
    const svc = new HealthService(
      deps({
        langfuseConfigured: () => true,
        langfuseCheck: async () => ({ ok: true, detail: 'reachable' })
      })
    )
    expect(svc.rows().some((r) => r.id === 'langfuse')).toBe(true)
    const results: HealthCheckResult[] = []
    await svc.run(['langfuse'], (r) => results.push(r))
    expect(results[0]).toMatchObject({ id: 'langfuse', ok: true, detail: 'reachable' })
  })

  it('omits the langfuse row when not configured', () => {
    const svc = new HealthService(
      deps({
        langfuseConfigured: () => false,
        langfuseCheck: async () => ({ ok: false, detail: '' })
      })
    )
    expect(svc.rows().some((r) => r.id === 'langfuse')).toBe(false)
  })
})
