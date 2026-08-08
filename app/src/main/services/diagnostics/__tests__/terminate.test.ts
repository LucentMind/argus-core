import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveTargets, Terminator, KILL_GRACE_MS } from '../terminate'
import type {
  DiagnosticsObject,
  DiagnosticsProcess,
  DiagnosticsSnapshot
} from '../../../../shared/diagnostics'

function proc(over: Partial<DiagnosticsProcess> & { pid: number }): DiagnosticsProcess {
  return {
    ppid: 1,
    startTimeMs: 1_000,
    depth: 1,
    name: `proc-${over.pid}`,
    cpuPercent: 0,
    cpuTimeMs: 0,
    residentBytes: 0,
    uptimeMs: 1_000,
    ...over
  }
}

function obj(over: Partial<DiagnosticsObject> & { id: string }): DiagnosticsObject {
  return {
    kind: 'mcp',
    label: 'MCP: demo',
    orphan: false,
    inferred: false,
    terminable: true,
    busy: false,
    rootPid: 2,
    processCount: 2,
    cpuPercent: 0,
    rssBytes: 0,
    uptimeMs: 1_000,
    ...over
  }
}

function snap(over: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot {
  return {
    readAt: 0,
    sampleIntervalMs: 1_000,
    cores: 4,
    totalMemoryBytes: 1_000,
    footprint: {
      processCount: 0,
      cpuPercent: 0,
      rssBytes: 0,
      peakRssBytes: 0,
      starts: 0,
      exits: 0,
      orphanCount: 0
    },
    objects: [],
    tree: [],
    sidecar: { status: 'healthy', version: '1', restartCount: 0, lastError: null },
    ...over
  }
}

describe('resolveTargets', () => {
  it('returns the subtree deepest-first', () => {
    const s = snap({
      objects: [obj({ id: '2:1000' })],
      tree: [
        proc({ pid: 1, ppid: 0, depth: 0 }),
        proc({ pid: 2, ppid: 1, depth: 1 }),
        proc({ pid: 3, ppid: 2, depth: 2 }),
        proc({ pid: 4, ppid: 3, depth: 3 })
      ]
    })
    const r = resolveTargets(s, '2:1000', new Set())
    expect(r).toEqual({
      ok: true,
      targets: [
        { pid: 4, startTimeMs: 1_000 },
        { pid: 3, startTimeMs: 1_000 },
        { pid: 2, startTimeMs: 1_000 }
      ]
    })
  })

  it('descends through a nested row, so a labeled child is not stranded', () => {
    const s = snap({
      objects: [obj({ id: '2:1000' }), obj({ id: '3:1000', rootPid: 3, processCount: 1 })],
      tree: [
        proc({ pid: 1, ppid: 0, depth: 0 }),
        proc({ pid: 2, ppid: 1, depth: 1 }),
        proc({ pid: 3, ppid: 2, depth: 2 })
      ]
    })
    const r = resolveTargets(s, '2:1000', new Set())
    expect(r).toEqual({
      ok: true,
      targets: [
        { pid: 3, startTimeMs: 1_000 },
        { pid: 2, startTimeMs: 1_000 }
      ]
    })
  })

  it('drops denied pids', () => {
    const s = snap({
      objects: [obj({ id: '2:1000' })],
      tree: [
        proc({ pid: 1, ppid: 0, depth: 0 }),
        proc({ pid: 2, ppid: 1, depth: 1 }),
        proc({ pid: 3, ppid: 2, depth: 2 })
      ]
    })
    expect(resolveTargets(s, '2:1000', new Set([3]))).toEqual({
      ok: true,
      targets: [{ pid: 2, startTimeMs: 1_000 }]
    })
  })

  it('drops electron processes even inside a terminable subtree', () => {
    const s = snap({
      objects: [obj({ id: '2:1000' })],
      tree: [
        proc({ pid: 1, ppid: 0, depth: 0 }),
        proc({ pid: 2, ppid: 1, depth: 1 }),
        proc({ pid: 3, ppid: 2, depth: 2, electronType: 'Utility' })
      ]
    })
    expect(resolveTargets(s, '2:1000', new Set())).toEqual({
      ok: true,
      targets: [{ pid: 2, startTimeMs: 1_000 }]
    })
  })

  it('refuses a row that is not terminable', () => {
    const s = snap({
      objects: [obj({ id: '2:1000', kind: 'electron-internal', terminable: false })],
      tree: [proc({ pid: 1, ppid: 0, depth: 0 }), proc({ pid: 2, ppid: 1, depth: 1 })]
    })
    expect(resolveTargets(s, '2:1000', new Set())).toEqual({
      ok: false,
      reason: 'not-terminable'
    })
  })

  it('reports an unknown id as gone', () => {
    expect(resolveTargets(snap(), '99:1', new Set())).toEqual({ ok: false, reason: 'gone' })
  })

  it('reports a row whose every pid is denied as gone rather than claiming success', () => {
    const s = snap({
      objects: [obj({ id: '2:1000' })],
      tree: [proc({ pid: 1, ppid: 0, depth: 0 }), proc({ pid: 2, ppid: 1, depth: 1 })]
    })
    expect(resolveTargets(s, '2:1000', new Set([2]))).toEqual({ ok: false, reason: 'gone' })
  })
})

describe('Terminator', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends SIGTERM to every target immediately', () => {
    const kill = vi.fn()
    new Terminator({ kill, stillIs: () => false }).signal([
      { pid: 3, startTimeMs: 1_000 },
      { pid: 2, startTimeMs: 1_000 }
    ])
    expect(kill.mock.calls).toEqual([
      [3, 'SIGTERM'],
      [2, 'SIGTERM']
    ])
  })

  it('escalates to SIGKILL only for targets whose identity the current tree still confirms after the grace window', () => {
    const kill = vi.fn()
    // Only pid 2, at exactly its original startTimeMs, is confirmed still alive by the
    // (fake) current-tree lookup — pid 3 exited and is gone.
    const stillIs = (pid: number, startTimeMs: number): boolean => pid === 2 && startTimeMs === 1_000
    new Terminator({ kill, stillIs }).signal([
      { pid: 3, startTimeMs: 1_000 },
      { pid: 2, startTimeMs: 1_000 }
    ])
    kill.mockClear()
    vi.advanceTimersByTime(KILL_GRACE_MS)
    expect(kill.mock.calls).toEqual([[2, 'SIGKILL']])
  })

  it('does NOT escalate to SIGKILL when a different process now holds the pid — the recycled-pid case', () => {
    // This is the hazard the whole id-with-startTimeMs design exists to close: pid 2
    // exited within the grace window and the OS handed the same pid to an unrelated
    // process before the timer fired. `stillIs` reports the CURRENT process at pid 2 (a
    // different startTimeMs), which must read as "not our target" — not as "still alive,
    // escalate". A liveness-only check (process.kill(pid,0)) would wrongly say yes here.
    const kill = vi.fn()
    const stillIs = (pid: number, startTimeMs: number): boolean =>
      pid === 2 && startTimeMs === 4_000 // the recycled process's own start time
    new Terminator({ kill, stillIs }).signal([{ pid: 2, startTimeMs: 1_000 }])
    kill.mockClear()
    vi.advanceTimersByTime(KILL_GRACE_MS)
    expect(kill).not.toHaveBeenCalled()
  })

  it('a throwing kill does not stop the remaining targets', () => {
    const kill = vi.fn((pid: number) => {
      if (pid === 3) throw new Error('ESRCH')
    })
    expect(() =>
      new Terminator({ kill, stillIs: () => false }).signal([
        { pid: 3, startTimeMs: 1_000 },
        { pid: 2, startTimeMs: 1_000 }
      ])
    ).not.toThrow()
    expect(kill).toHaveBeenCalledWith(2, 'SIGTERM')
  })

  it('dispose cancels a pending escalation', () => {
    const kill = vi.fn()
    const t = new Terminator({ kill, stillIs: () => true })
    t.signal([{ pid: 2, startTimeMs: 1_000 }])
    kill.mockClear()
    t.dispose()
    vi.advanceTimersByTime(KILL_GRACE_MS)
    expect(kill).not.toHaveBeenCalled()
  })
})
