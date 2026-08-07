import { describe, it, expect } from 'vitest'
import {
  buildSnapshot,
  counterDelta,
  identityKey,
  type BuildResult,
  type ProcessState
} from '../model'
import type { ProcessSample } from '../../../../shared/diagnostics'
import type { RegisteredLabel } from '../processLabels'

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
    labelSources: { windows: [], connectors: [], registered: new Map() },
    liveOwners: new Set(),
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
      electronMetrics: [],
      labelSources: { windows: [], connectors: [], registered: new Map() },
      liveOwners: new Set()
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
      electronMetrics: [],
      labelSources: { windows: [], connectors: [], registered: new Map() },
      liveOwners: new Set()
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

describe('buildSnapshot — object rollup', () => {
  const CONNECTORS = [{ instanceId: 'github', command: 'npx', args: ['@x/server-github'] }]

  it('puts everything in one Unattributed row when nothing matches', () => {
    const r = build([ROOT, sample({ pid: 2, ppid: 1, residentBytes: 300 })], new Map(), 2_000)
    expect(r.objects).toHaveLength(1)
    expect(r.objects[0]).toMatchObject({
      id: 'unattributed',
      kind: 'unattributed',
      label: 'Unattributed',
      rootPid: null,
      processCount: 2,
      uptimeMs: 0
    })
  })

  it('rolls an unlabeled descendant up into its nearest labeled ancestor', () => {
    // npx (labeled as the github connector) -> node (unlabeled) must be ONE row.
    const npx = sample({
      pid: 2,
      ppid: 1,
      command: 'npx @x/server-github',
      residentBytes: 100,
      runTimeMs: 7_000
    })
    const node = sample({ pid: 3, ppid: 2, command: '/usr/bin/node index.js', residentBytes: 400 })
    const r = build([ROOT, npx, node], new Map(), 2_000, {
      labelSources: { windows: [], connectors: CONNECTORS, registered: new Map() }
    })

    const mcp = r.objects.find((o) => o.kind === 'mcp')
    expect(mcp).toMatchObject({
      id: '2:1000',
      label: 'MCP: github',
      instanceId: 'github',
      inferred: true,
      rootPid: 2,
      processCount: 2,
      rssBytes: 500,
      uptimeMs: 7_000
    })
  })

  it('breaks a labeled descendant out of its ancestor row, excluding its cost', () => {
    // claude (driver) -> npx (connector). The connector's memory must NOT count
    // toward the driver row, or a wedged MCP server reads as a wedged driver.
    const claude = sample({
      pid: 2,
      ppid: 1,
      command: '/usr/local/bin/claude --print',
      residentBytes: 100
    })
    const npx = sample({ pid: 3, ppid: 2, command: 'npx @x/server-github', residentBytes: 400 })
    const r = build([ROOT, claude, npx], new Map(), 2_000, {
      labelSources: { windows: [], connectors: CONNECTORS, registered: new Map() }
    })

    expect(r.objects.find((o) => o.kind === 'driver')).toMatchObject({
      rssBytes: 100,
      processCount: 1
    })
    expect(r.objects.find((o) => o.kind === 'mcp')).toMatchObject({
      rssBytes: 400,
      processCount: 1
    })
  })

  it('reconciles exactly with the footprint', () => {
    const claude = sample({
      pid: 2,
      ppid: 1,
      command: '/usr/local/bin/claude',
      cpuTimeMs: 400,
      residentBytes: 100
    })
    const npx = sample({
      pid: 3,
      ppid: 2,
      command: 'npx @x/server-github',
      cpuTimeMs: 200,
      residentBytes: 400
    })
    const stray = sample({ pid: 4, ppid: 1, cpuTimeMs: 100, residentBytes: 7 })
    const samples = [ROOT, claude, npx, stray]

    const previous = new Map<string, ProcessState>(
      samples.map((s) => [
        identityKey(s.pid, s.startTimeMs),
        { cpuTimeMs: 0, residentBytes: 0, sampledAtMs: 1_000 }
      ])
    )
    const r = build(samples, previous, 2_000, {
      labelSources: { windows: [], connectors: CONNECTORS, registered: new Map() }
    })

    const sum = (f: (o: (typeof r.objects)[number]) => number): number =>
      r.objects.reduce((t, o) => t + f(o), 0)
    expect(sum((o) => o.processCount)).toBe(r.footprint.processCount)
    expect(sum((o) => o.rssBytes)).toBe(r.footprint.rssBytes)
    expect(sum((o) => o.cpuPercent)).toBe(r.footprint.cpuPercent)
    expect(r.footprint.cpuPercent).toBeGreaterThan(0)
  })

  it('derives footprint.cpuPercent from the rows even when summation order matters', () => {
    // Every cpuTimeMs delta above (400, 200, 100) divides evenly into a dyadic
    // cpuPercent, so summing rows-then-reduce and accumulating in the per-process
    // loop are bit-identical there — that test would still pass if the
    // derivation were replaced by a loop accumulator. Here the deltas (5, 5, 5,
    // 39) over a 3000ms/4-core window land on repeating binary fractions
    // (denominator 120 = 2^3*3*5, so any delta not a multiple of 15 is
    // non-dyadic), so grouping by row before reducing lands on a DIFFERENT float
    // than flattening all five processes into one running total in traversal
    // order. Verified empirically: rows-then-reduce yields
    // 0.45000000000000007..., a flat accumulator yields 0.45 exactly.
    const claude = sample({
      pid: 2,
      ppid: 1,
      command: '/usr/local/bin/claude',
      cpuTimeMs: 5,
      residentBytes: 100
    })
    const npx = sample({
      pid: 3,
      ppid: 2,
      command: 'npx @x/server-github',
      cpuTimeMs: 5,
      residentBytes: 400
    })
    const strayA = sample({ pid: 4, ppid: 1, cpuTimeMs: 5, residentBytes: 250 })
    const strayB = sample({ pid: 5, ppid: 1, cpuTimeMs: 39, residentBytes: 40 })
    const samples = [ROOT, claude, npx, strayA, strayB]

    const previous = new Map<string, ProcessState>(
      samples.map((s) => [
        identityKey(s.pid, s.startTimeMs),
        { cpuTimeMs: 0, residentBytes: 0, sampledAtMs: 1_000 }
      ])
    )
    const r = build(samples, previous, 4_000, {
      labelSources: { windows: [], connectors: CONNECTORS, registered: new Map() }
    })

    const derivedFromRows = r.objects.reduce((t, o) => t + o.cpuPercent, 0)
    expect(r.footprint.cpuPercent).toBe(derivedFromRows)
    expect(r.footprint.cpuPercent).toBe(0.45000000000000007)
  })

  it('sorts by memory descending and pins Unattributed last', () => {
    const small = sample({
      pid: 2,
      ppid: 1,
      command: '/usr/local/bin/claude',
      residentBytes: 100
    })
    const big = sample({ pid: 3, ppid: 1, command: 'npx @x/server-github', residentBytes: 900 })
    const stray = sample({ pid: 4, ppid: 1, residentBytes: 5_000 })
    const r = build([ROOT, small, big, stray], new Map(), 2_000, {
      labelSources: { windows: [], connectors: CONNECTORS, registered: new Map() }
    })
    expect(r.objects.map((o) => o.kind)).toEqual(['mcp', 'driver', 'unattributed'])
  })

  it('keeps a row id stable across ticks while its root process lives', () => {
    const claude = sample({ pid: 2, ppid: 1, command: '/usr/local/bin/claude' })
    const first = build([ROOT, claude], new Map(), 2_000)
    const second = build([ROOT, claude], first.next, 3_000)
    expect(first.objects.find((o) => o.kind === 'driver')?.id).toBe('2:1000')
    expect(second.objects.find((o) => o.kind === 'driver')?.id).toBe('2:1000')
  })

  it('omits provider on an mcp row and instanceId on a driver row', () => {
    // The mcp label carries instanceId but no provider; the driver label carries
    // provider but no instanceId. Each is therefore the legitimate case where
    // model.ts's conditional spread (model.ts:164-165) must OMIT the other key
    // entirely rather than set it to `undefined` — `'k' in obj` distinguishes
    // "key absent" from "key present with value undefined", which
    // toBeUndefined() cannot: it passes identically for both.
    const claude = sample({ pid: 2, ppid: 1, command: '/usr/local/bin/claude' })
    const npx = sample({ pid: 3, ppid: 1, command: 'npx @x/server-github' })
    const r = build([ROOT, claude, npx], new Map(), 2_000, {
      labelSources: { windows: [], connectors: CONNECTORS, registered: new Map() }
    })

    const driver = r.objects.find((o) => o.kind === 'driver')
    const mcp = r.objects.find((o) => o.kind === 'mcp')
    expect(driver).toBeDefined()
    expect(mcp).toBeDefined()

    expect('instanceId' in driver!).toBe(false)
    expect(driver).toHaveProperty('provider', 'claude-agent-sdk')

    expect('provider' in mcp!).toBe(false)
    expect(mcp).toHaveProperty('instanceId', 'github')
  })

  describe('electron-internal rows do not adopt unlabeled descendants', () => {
    const ELECTRON_MAIN = [{ pid: 1, creationTimeMs: 1_000, type: 'Browser' as const }]

    it('sends an unlabeled child of the Electron main root to unattributed, not the main-process row', () => {
      const child = sample({ pid: 2, ppid: 1, residentBytes: 300 })
      const r = build([ROOT, child], new Map(), 2_000, { electronMetrics: ELECTRON_MAIN })

      const main = r.objects.find((o) => o.kind === 'electron-internal')
      const unattributed = r.objects.find((o) => o.kind === 'unattributed')
      expect(main).toMatchObject({ label: 'Argus main process', processCount: 1 })
      expect(unattributed).toMatchObject({ id: 'unattributed', processCount: 1, rssBytes: 300 })
    })

    it('sends an unlabeled grandchild under the Electron main root to unattributed too', () => {
      const child = sample({ pid: 2, ppid: 1, residentBytes: 100 })
      const grandchild = sample({ pid: 3, ppid: 2, residentBytes: 50 })
      const r = build([ROOT, child, grandchild], new Map(), 2_000, {
        electronMetrics: ELECTRON_MAIN
      })

      const main = r.objects.find((o) => o.kind === 'electron-internal')
      const unattributed = r.objects.find((o) => o.kind === 'unattributed')
      expect(main).toMatchObject({ processCount: 1 })
      expect(unattributed).toMatchObject({ processCount: 2, rssBytes: 150 })
    })

    it('still rolls an unlabeled child up into a non-electron-internal ancestor (mcp)', () => {
      const npx = sample({
        pid: 2,
        ppid: 1,
        command: 'npx @x/server-github',
        residentBytes: 100
      })
      const node = sample({
        pid: 3,
        ppid: 2,
        command: '/usr/bin/node index.js',
        residentBytes: 400
      })
      const r = build([ROOT, npx, node], new Map(), 2_000, {
        electronMetrics: ELECTRON_MAIN,
        labelSources: { windows: [], connectors: CONNECTORS, registered: new Map() }
      })

      const mcp = r.objects.find((o) => o.kind === 'mcp')
      expect(mcp).toMatchObject({ processCount: 2, rssBytes: 500 })
    })

    it('still reconciles exactly with the footprint when unattributed absorbs an electron-internal child', () => {
      const child = sample({ pid: 2, ppid: 1, cpuTimeMs: 100, residentBytes: 300 })
      const grandchild = sample({ pid: 3, ppid: 2, cpuTimeMs: 50, residentBytes: 20 })
      const samples = [ROOT, child, grandchild]
      const previous = new Map<string, ProcessState>(
        samples.map((s) => [
          identityKey(s.pid, s.startTimeMs),
          { cpuTimeMs: 0, residentBytes: 0, sampledAtMs: 1_000 }
        ])
      )
      const r = build(samples, previous, 2_000, { electronMetrics: ELECTRON_MAIN })

      const sum = (f: (o: (typeof r.objects)[number]) => number): number =>
        r.objects.reduce((t, o) => t + f(o), 0)
      expect(sum((o) => o.processCount)).toBe(r.footprint.processCount)
      expect(sum((o) => o.rssBytes)).toBe(r.footprint.rssBytes)
      expect(sum((o) => o.cpuPercent)).toBe(r.footprint.cpuPercent)
    })
  })
})

describe('buildSnapshot — orphan detection', () => {
  const owned = (owner: string): ReadonlyMap<string, RegisteredLabel> =>
    new Map([['2:1000', { kind: 'driver' as const, label: 'Codex driver', owner }]])

  it('flags a registered row whose owner is no longer live', () => {
    const r = build([ROOT, sample({ pid: 2, ppid: 1 })], new Map(), 2_000, {
      labelSources: { windows: [], connectors: [], registered: owned('CASE-A:7') },
      liveOwners: new Set(['CASE-B:9'])
    })
    const driver = r.objects.find((o) => o.kind === 'driver')
    expect(driver?.orphan).toBe(true)
    expect(r.footprint.orphanCount).toBe(1)
  })

  it('does not flag a row whose owner is still live', () => {
    const r = build([ROOT, sample({ pid: 2, ppid: 1 })], new Map(), 2_000, {
      labelSources: { windows: [], connectors: [], registered: owned('CASE-A:7') },
      liveOwners: new Set(['CASE-A:7'])
    })
    expect(r.objects.find((o) => o.kind === 'driver')?.orphan).toBe(false)
    expect(r.footprint.orphanCount).toBe(0)
  })

  it('never flags a LABELED row that carries no owner', () => {
    // Tier B (Electron) and tier C (command-line inference) rows have no owner;
    // an empty live-owner set must not make them read as orphaned. This uses a
    // real tier-B row (matched via electronMetrics), not the synthetic
    // Unattributed row — Unattributed's `orphan: false` is a hardcoded literal
    // in model.ts and would pass this assertion regardless of what the orphan
    // guard does, proving nothing about the guard itself.
    const r = build([ROOT, sample({ pid: 2, ppid: 1 })], new Map(), 2_000, {
      electronMetrics: [{ pid: 2, creationTimeMs: 1_000, type: 'Renderer' }],
      liveOwners: new Set<string>()
    })
    const electronRow = r.objects.find((o) => o.kind === 'electron-internal')
    expect(electronRow).not.toHaveProperty('owner')
    expect(electronRow?.orphan).toBe(false)
    expect(r.objects.every((o) => o.orphan === false)).toBe(true)
    expect(r.footprint.orphanCount).toBe(0)
  })
})
