import { describe, it, expect, vi } from 'vitest'
import { ProcessLabels, PIN_TOLERANCE_MS } from '../processLabels'
import type { ProcessSample } from '../../../../shared/diagnostics'

function sample(over: Partial<ProcessSample> & { pid: number }): ProcessSample {
  return {
    ppid: 1,
    startTimeMs: 10_000,
    runTimeMs: 5_000,
    name: `proc-${over.pid}`,
    command: `/bin/proc-${over.pid}`,
    status: 'Run',
    cpuTimeMs: 0,
    residentBytes: 0,
    ...over
  }
}

const DRIVER = {
  kind: 'driver' as const,
  label: 'Cursor driver',
  provider: 'cursor',
  owner: 'CASE-A:7'
}

describe('ProcessLabels', () => {
  it('does not surface a registration until a sample pins it', () => {
    const r = new ProcessLabels()
    r.register(50, DRIVER, 10_000)
    // Nothing observed yet: an unpinned entry must never produce an object row,
    // or a pid we merely *asked* to spawn would appear as a live process.
    expect(r.reconcile([], 10_100).size).toBe(0)
    expect(r.pinnedCount()).toBe(0)
  })

  it('pins to the observed startTimeMs when it falls inside the tolerance', () => {
    const r = new ProcessLabels()
    r.register(50, DRIVER, 10_000)
    const map = r.reconcile([sample({ pid: 50, startTimeMs: 12_000 })], 12_100)
    expect(map.get('50:12000')).toEqual(DRIVER)
    expect(r.pinnedCount()).toBe(1)
  })

  it('discards a registration whose observed start time is outside the tolerance', () => {
    // The pid was reused by an unrelated process that started long before we asked
    // for ours. Mislabelling it would be worse than not labelling it.
    const r = new ProcessLabels()
    r.register(50, DRIVER, 10_000)
    const map = r.reconcile(
      [sample({ pid: 50, startTimeMs: 10_000 - PIN_TOLERANCE_MS - 1 })],
      10_100
    )
    expect(map.size).toBe(0)
    expect(r.pinnedCount()).toBe(0)
    // Discarded, not merely skipped: a later correct sample must not resurrect it.
    expect(r.reconcile([sample({ pid: 50, startTimeMs: 10_500 })], 10_600).size).toBe(0)
  })

  it('keeps a pinned entry stable across ticks', () => {
    const r = new ProcessLabels()
    r.register(50, DRIVER, 10_000)
    r.reconcile([sample({ pid: 50, startTimeMs: 10_100 })], 10_200)
    const second = r.reconcile([sample({ pid: 50, startTimeMs: 10_100 })], 11_200)
    expect(second.get('50:10100')).toEqual(DRIVER)
  })

  it('drops a pinned entry once its process leaves the sample set', () => {
    const r = new ProcessLabels()
    r.register(50, DRIVER, 10_000)
    r.reconcile([sample({ pid: 50, startTimeMs: 10_100 })], 10_200)
    expect(r.reconcile([], 11_200).size).toBe(0)
    expect(r.pinnedCount()).toBe(0)
  })

  it('drops a pinned entry when the pid is reused by a different process', () => {
    const r = new ProcessLabels()
    r.register(50, DRIVER, 10_000)
    r.reconcile([sample({ pid: 50, startTimeMs: 10_100 })], 10_200)
    // Same pid, different start time => a different process. The old label must not
    // transfer, and must not linger.
    const map = r.reconcile([sample({ pid: 50, startTimeMs: 99_000 })], 99_100)
    expect(map.size).toBe(0)
    expect(r.pinnedCount()).toBe(0)
  })

  it('expires an unpinned registration no sample ever confirmed', () => {
    // Otherwise a failed spawn leaks an entry forever.
    const r = new ProcessLabels()
    r.register(50, DRIVER, 10_000)
    expect(r.reconcile([], 10_000 + PIN_TOLERANCE_MS + 1).size).toBe(0)
    expect(r.reconcile([sample({ pid: 50, startTimeMs: 10_100 })], 10_200).size).toBe(0)
  })

  it('unregister removes both pinned and unpinned entries', () => {
    const r = new ProcessLabels()
    r.register(50, DRIVER, 10_000)
    r.register(51, DRIVER, 10_000)
    r.reconcile([sample({ pid: 51, startTimeMs: 10_100 })], 10_200)
    r.unregister(50)
    r.unregister(51)
    expect(r.reconcile([sample({ pid: 51, startTimeMs: 10_100 })], 10_300).size).toBe(0)
  })

  it('does not let a throwing onRegister listener propagate out of register()', () => {
    // register() runs synchronously inside every spawn site (drivers, MCP,
    // panels). A listener throw must degrade the Diagnostics page, never the
    // app that just spawned a process.
    const r = new ProcessLabels()
    r.onRegister(() => {
      throw new Error('listener boom')
    })
    let secondCalls = 0
    r.onRegister(() => {
      secondCalls += 1
    })

    expect(() => r.register(50, DRIVER, 10_000)).not.toThrow()
    expect(secondCalls).toBe(1)
  })

  it('keeps registrations for distinct pids independent', () => {
    const r = new ProcessLabels()
    const mcp = { kind: 'mcp' as const, label: 'MCP probe: github', instanceId: 'github' }
    r.register(50, DRIVER, 10_000)
    r.register(60, mcp, 10_000)
    const map = r.reconcile(
      [sample({ pid: 50, startTimeMs: 10_100 }), sample({ pid: 60, startTimeMs: 10_100 })],
      10_200
    )
    expect(map.get('50:10100')).toEqual(DRIVER)
    expect(map.get('60:10100')).toEqual(mcp)
  })
})

describe('stopFor', () => {
  it('returns the closure for a pinned entry', () => {
    const labels = new ProcessLabels()
    const stop = vi.fn()
    labels.register(7, { kind: 'pack-app', label: 'Pack app: demo/console', stop }, 1_000)
    labels.reconcile([sample({ pid: 7, startTimeMs: 1_200 })], 1_300)
    expect(labels.stopFor('7:1200')).toBe(stop)
  })

  it('returns null while the entry is still unpinned', () => {
    const labels = new ProcessLabels()
    labels.register(7, { kind: 'pack-app', label: 'Pack app: demo/console', stop: vi.fn() }, 1_000)
    expect(labels.stopFor('7:1200')).toBeNull()
  })

  it('does not answer for an unpinned entry even when the id matches its undefined identity', () => {
    // stopFor's guard skips entries whose startTimeMs is still undefined. Without
    // that guard, identityKey(7, undefined) collapses to the literal string
    // '7:undefined', which — queried here — WOULD match and hand back the
    // closure for a pid we have not yet proven is ours. Querying '7:1200' (as the
    // sibling test above does) can never catch that: it fails to match regardless
    // of the guard, so it passes for the wrong reason. This id is the one string
    // that only the guard can save us from.
    const labels = new ProcessLabels()
    labels.register(7, { kind: 'pack-app', label: 'Pack app: demo/console', stop: vi.fn() }, 1_000)
    expect(labels.stopFor('7:undefined')).toBeNull()
  })

  it('returns null when the start time does not match the pinned identity', () => {
    const labels = new ProcessLabels()
    labels.register(7, { kind: 'pack-app', label: 'Pack app: demo/console', stop: vi.fn() }, 1_000)
    labels.reconcile([sample({ pid: 7, startTimeMs: 1_200 })], 1_300)
    expect(labels.stopFor('7:9999')).toBeNull()
  })

  it('returns null for a pinned entry that registered no closure', () => {
    const labels = new ProcessLabels()
    labels.register(7, { kind: 'mcp', label: 'MCP: demo' }, 1_000)
    labels.reconcile([sample({ pid: 7, startTimeMs: 1_200 })], 1_300)
    expect(labels.stopFor('7:1200')).toBeNull()
  })
})
