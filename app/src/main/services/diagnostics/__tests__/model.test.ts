import { describe, it, expect } from 'vitest'
import {
  buildSnapshot,
  counterDelta,
  identityKey,
  type BuildResult,
  type ProcessState
} from '../model'
import type { ProcessSample } from '../../../../shared/diagnostics'

function sample(over: Partial<ProcessSample> & { pid: number }): ProcessSample {
  return {
    ppid: 1,
    startTimeMs: 1_000,
    runTimeMs: 5_000,
    name: `proc-${over.pid}`,
    command: `/bin/proc-${over.pid}`,
    status: 'Run',
    cpuTimeMs: 0,
    residentBytes: 0,
    ...over
  }
}

const ROOT = sample({ pid: 1, ppid: 0 })

function build(
  samples: ProcessSample[],
  previous: Map<string, ProcessState>,
  sampledAtMs: number,
  extra: Partial<Parameters<typeof buildSnapshot>[0]> = {}
): BuildResult {
  return buildSnapshot({
    samples,
    previous,
    previousPeakRssBytes: 0,
    counters: { starts: 0, exits: 0 },
    sampledAtMs,
    rootPid: 1,
    cores: 4,
    electronMetrics: [],
    ...extra
  })
}

describe('counterDelta', () => {
  it('returns the difference for a normal advance', () => {
    expect(counterDelta(500, 200, 1_000)).toBe(300)
  })

  it('returns 0 when the counter went backwards (pid reuse)', () => {
    expect(counterDelta(10, 900, 1_000)).toBe(0)
  })

  it('returns 0 when the gap is too long to trust', () => {
    expect(counterDelta(900, 10, 31_000)).toBe(0)
  })

  it('returns 0 for a non-positive elapsed time', () => {
    expect(counterDelta(900, 10, 0)).toBe(0)
  })
})

describe('buildSnapshot', () => {
  it('reports 0% CPU on first sight, because there is no baseline', () => {
    const r = build([ROOT], new Map(), 10_000)
    expect(r.tree).toHaveLength(1)
    expect(r.tree[0].cpuPercent).toBe(0)
  })

  it('does not carry the raw command line into the renderable tree', () => {
    // ProcessSample.command exists (argv is needed on the main side to identify
    // provider CLIs / MCP servers), but DiagnosticsProcess must not expose it —
    // Argus spawns provider CLIs and MCP servers, so argv can contain paths, case
    // identifiers, or credentials that have no reason to sit in renderer memory.
    const r = build([ROOT], new Map(), 10_000)
    expect(r.tree[0]).not.toHaveProperty('command')
  })

  it('normalises CPU to percent-of-machine using the core count', () => {
    const prev = new Map<string, ProcessState>([
      [identityKey(1, 1_000), { cpuTimeMs: 0, residentBytes: 0, sampledAtMs: 9_000 }]
    ])
    // 1000ms of CPU over 1000ms elapsed = one full core. On 4 cores that is 25%.
    const r = build([sample({ pid: 1, ppid: 0, cpuTimeMs: 1_000 })], prev, 10_000)
    expect(r.tree[0].cpuPercent).toBeCloseTo(25, 5)
  })

  it('does not spike when a counter decreases', () => {
    const prev = new Map<string, ProcessState>([
      [identityKey(1, 1_000), { cpuTimeMs: 5_000, residentBytes: 0, sampledAtMs: 9_000 }]
    ])
    const r = build([sample({ pid: 1, ppid: 0, cpuTimeMs: 3 })], prev, 10_000)
    expect(r.tree[0].cpuPercent).toBe(0)
  })

  it('does not spike after a gap longer than the trust window', () => {
    const prev = new Map<string, ProcessState>([
      [identityKey(1, 1_000), { cpuTimeMs: 0, residentBytes: 0, sampledAtMs: 0 }]
    ])
    const r = build([sample({ pid: 1, ppid: 0, cpuTimeMs: 100_000 })], prev, 60_000)
    expect(r.tree[0].cpuPercent).toBe(0)
  })

  it('treats a reused pid as an exit plus a new process', () => {
    const prev = new Map<string, ProcessState>([
      [identityKey(7, 1_000), { cpuTimeMs: 4_000, residentBytes: 10, sampledAtMs: 9_000 }]
    ])
    const reused = sample({ pid: 7, startTimeMs: 8_000, cpuTimeMs: 50 })
    const r = build([ROOT, reused], prev, 10_000)
    const row = r.tree.find((p) => p.pid === 7)
    expect(row?.cpuPercent).toBe(0) // no baseline for the NEW identity
    expect(r.footprint.starts).toBe(2) // root + the new identity
    expect(r.footprint.exits).toBe(1) // the old pid 7
  })

  it('orders the tree depth-first with the root at depth 0', () => {
    const tree = [
      ROOT,
      sample({ pid: 2, ppid: 1 }),
      sample({ pid: 4, ppid: 2 }),
      sample({ pid: 3, ppid: 1 })
    ]
    const r = build(tree, new Map(), 10_000)
    expect(r.tree.map((p) => p.pid)).toEqual([1, 2, 4, 3])
    expect(r.tree.map((p) => p.depth)).toEqual([0, 1, 2, 1])
  })

  it('sums RSS and CPU across the tree into the footprint', () => {
    const prev = new Map<string, ProcessState>([
      [identityKey(1, 1_000), { cpuTimeMs: 0, residentBytes: 0, sampledAtMs: 9_000 }],
      [identityKey(2, 1_000), { cpuTimeMs: 0, residentBytes: 0, sampledAtMs: 9_000 }]
    ])
    const r = build(
      [
        sample({ pid: 1, ppid: 0, cpuTimeMs: 1_000, residentBytes: 100 }),
        sample({ pid: 2, ppid: 1, cpuTimeMs: 1_000, residentBytes: 250 })
      ],
      prev,
      10_000
    )
    expect(r.footprint.rssBytes).toBe(350)
    expect(r.footprint.processCount).toBe(2)
    expect(r.footprint.cpuPercent).toBeCloseTo(50, 5)
  })

  it('tracks peak RSS as a running max of the total, not a sum of per-process peaks', () => {
    const first = build(
      [
        sample({ pid: 1, ppid: 0, residentBytes: 100 }),
        sample({ pid: 2, ppid: 1, residentBytes: 0 })
      ],
      new Map(),
      10_000
    )
    const second = buildSnapshot({
      samples: [
        sample({ pid: 1, ppid: 0, residentBytes: 0 }),
        sample({ pid: 2, ppid: 1, residentBytes: 100 })
      ],
      previous: first.next,
      previousPeakRssBytes: first.footprint.peakRssBytes,
      counters: first.counters,
      sampledAtMs: 11_000,
      rootPid: 1,
      cores: 4,
      electronMetrics: []
    })
    // Each process peaked at 100 at different moments, but the total never exceeded 100.
    expect(second.footprint.peakRssBytes).toBe(100)
  })

  it('labels a process from a matching electron metric', () => {
    const r = build([ROOT], new Map(), 10_000, {
      electronMetrics: [{ pid: 1, creationTimeMs: 1_000, type: 'Browser' }]
    })
    expect(r.tree[0].electronType).toBe('Browser')
  })

  it('ignores a stale electron metric whose creation time does not match', () => {
    const r = build([ROOT], new Map(), 10_000, {
      electronMetrics: [{ pid: 1, creationTimeMs: 999_999, type: 'Browser' }]
    })
    expect(r.tree[0].electronType).toBeUndefined()
  })

  it('counts an exit when a process disappears', () => {
    const first = build([ROOT, sample({ pid: 2, ppid: 1 })], new Map(), 10_000)
    const second = buildSnapshot({
      samples: [ROOT],
      previous: first.next,
      previousPeakRssBytes: first.footprint.peakRssBytes,
      counters: first.counters,
      sampledAtMs: 11_000,
      rootPid: 1,
      cores: 4,
      electronMetrics: []
    })
    expect(second.footprint.exits).toBe(1)
    expect(second.footprint.starts).toBe(2)
  })

  it('keeps a process whose parent is missing rather than losing it entirely', () => {
    // Defensive: the sidecar guarantees a connected tree, but a race between the
    // pid scan and the detail read could orphan a row. It must still appear.
    const r = build([ROOT, sample({ pid: 5, ppid: 4242 })], new Map(), 10_000)
    expect(r.tree.map((p) => p.pid)).toContain(5)
  })
})
