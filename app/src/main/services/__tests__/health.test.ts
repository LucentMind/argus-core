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
  probeTools: async () => ({
    parseBin: { path: 'C:\\sample-parse.exe', version: '0.3.0' },
    traceDir: { path: 'C:\\trace', found: true }
  }),
  preflight: async () => ({ ok: true, checks: [{ name: 'python', ok: true, detail: '3.11' }] }),
  agentAuth: async () => ({ ok: true, detail: 'logged in as x@y' }),
  gh: async () => ({ ok: true, detail: 'Logged in to github.com' }),
  enabledConnectors: () => ['rovo'],
  probeConnector: async () => ({ ok: true, tools: [{ name: 'get_x', risk: 'low' }] }),
  atlassianConfigured: () => false,
  atlassianCheck: async () => ({ ok: false, detail: 'unset' }),
  ...over
})

async function runAll(d: HealthDeps, ids: string[] | null = null): Promise<HealthCheckResult[]> {
  const out: HealthCheckResult[] = []
  await new HealthService(d).run(ids, (r) => out.push(r))
  return out
}

describe('HealthService', () => {
  it('rows: five static checks plus one per enabled connector', () => {
    const rows = new HealthService(deps()).rows()
    expect(rows.map((r) => r.id)).toEqual([
      'parse',
      'trace',
      'gh',
      'agent',
      'data-root',
      'connector:rovo'
    ])
  })

  it('run(null) emits a result per row; all green with healthy deps', async () => {
    const out = await runAll(deps())
    expect(out).toHaveLength(6)
    expect(out.every((r) => r.ok)).toBe(true)
    expect(out.find((r) => r.id === 'parse')!.detail).toContain('0.3.0')
    expect(out.find((r) => r.id === 'connector:rovo')!.detail).toContain('1 tools')
  })

  it('failures carry detail + fixHint and never throw', async () => {
    const out = await runAll(
      deps({
        probeTools: async () => ({
          parseBin: { path: null, version: null },
          traceDir: { path: null, found: false }
        }),
        preflight: async () => ({
          ok: false,
          checks: [{ name: 'python', ok: false, detail: 'not found' }]
        }),
        agentAuth: async () => ({ ok: false, detail: 'not logged in' }),
        gh: async () => ({ ok: false, detail: 'gh not installed' }),
        probeConnector: async () => ({ ok: false, error: 'connect ECONNREFUSED' })
      })
    )
    expect(out.every((r) => !r.ok || r.id === 'data-root')).toBe(true)
    for (const id of ['parse', 'trace', 'gh', 'agent', 'connector:rovo'])
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
})
