import type {
  DiagnosticsAggregate,
  DiagnosticsObject,
  DiagnosticsProcess,
  ElectronProcessMetric,
  ProcessSample
} from '../../../shared/diagnostics'

/**
 * Pure transformation of raw sidecar samples into a renderable snapshot.
 *
 * No I/O, no electron import, no clock read — every input is a parameter, so
 * every edge case (pid reuse, counter resets, long gaps) is directly testable.
 */

/** Beyond this gap a counter delta is not trustworthy and is reported as zero. */
export const MAX_DELTA_INTERVAL_MS = 30_000

/** Electron reports creation time separately from the OS; allow for clock skew. */
const ELECTRON_IDENTITY_TOLERANCE_MS = 2_000

export type ProcessState = {
  cpuTimeMs: number
  residentBytes: number
  sampledAtMs: number
}

export type BuildInput = {
  samples: ProcessSample[]
  previous: ReadonlyMap<string, ProcessState>
  previousPeakRssBytes: number
  counters: { starts: number; exits: number }
  sampledAtMs: number
  rootPid: number
  cores: number
  electronMetrics: ElectronProcessMetric[]
}

export type BuildResult = {
  tree: DiagnosticsProcess[]
  objects: DiagnosticsObject[]
  footprint: DiagnosticsAggregate
  next: Map<string, ProcessState>
  counters: { starts: number; exits: number }
}

export function identityKey(pid: number, startTimeMs: number): string {
  return `${pid}:${startTimeMs}`
}

/**
 * Difference between two readings of a monotonic counter, or 0 when the reading
 * cannot be trusted: a non-positive or over-long gap, or a counter that went
 * backwards (which means the pid was reused by a different process).
 */
export function counterDelta(current: number, previous: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || elapsedMs > MAX_DELTA_INTERVAL_MS) return 0
  if (current < previous) return 0
  return current - previous
}

function matchElectronMetric(
  sample: ProcessSample,
  metrics: ElectronProcessMetric[]
): ElectronProcessMetric | undefined {
  return metrics.find(
    (m) =>
      m.pid === sample.pid &&
      Math.abs(m.creationTimeMs - sample.startTimeMs) <= ELECTRON_IDENTITY_TOLERANCE_MS
  )
}

/** Depth-first order from the root, so a child always follows its parent. */
function orderDepthFirst(
  samples: ProcessSample[],
  rootPid: number
): { s: ProcessSample; depth: number }[] {
  const childrenOf = new Map<number, ProcessSample[]>()
  for (const s of samples) {
    if (s.pid === s.ppid) continue
    const list = childrenOf.get(s.ppid)
    if (list) list.push(s)
    else childrenOf.set(s.ppid, [s])
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.pid - b.pid)

  const ordered: { s: ProcessSample; depth: number }[] = []
  const seen = new Set<number>()

  const visit = (s: ProcessSample, depth: number): void => {
    if (seen.has(s.pid)) return
    seen.add(s.pid)
    ordered.push({ s, depth })
    for (const child of childrenOf.get(s.pid) ?? []) visit(child, depth + 1)
  }

  const root = samples.find((s) => s.pid === rootPid)
  if (root) visit(root, 0)
  // Anything not reachable from the root (an orphan from a scan race) still gets
  // a row rather than vanishing.
  for (const s of samples) if (!seen.has(s.pid)) visit(s, 0)
  return ordered
}

export function buildSnapshot(input: BuildInput): BuildResult {
  const ordered = orderDepthFirst(input.samples, input.rootPid)
  const next = new Map<string, ProcessState>()
  const tree: DiagnosticsProcess[] = []

  let totalCpuPercent = 0
  let totalRss = 0

  for (const { s, depth } of ordered) {
    const key = identityKey(s.pid, s.startTimeMs)
    const prev = input.previous.get(key)
    const elapsedMs = prev ? input.sampledAtMs - prev.sampledAtMs : 0

    // Percent-of-one-core first, then divided by the core count so the displayed
    // number answers "how much of this machine", not "how much of one core".
    const cpuDelta = prev ? counterDelta(s.cpuTimeMs, prev.cpuTimeMs, elapsedMs) : 0
    const perCore = prev && elapsedMs > 0 ? (cpuDelta / elapsedMs) * 100 : 0
    const cpuPercent = input.cores > 0 ? perCore / input.cores : 0

    const electron = matchElectronMetric(s, input.electronMetrics)

    tree.push({
      pid: s.pid,
      startTimeMs: s.startTimeMs,
      ppid: s.ppid,
      depth,
      name: s.name,
      cpuPercent,
      cpuTimeMs: s.cpuTimeMs,
      residentBytes: s.residentBytes,
      uptimeMs: s.runTimeMs,
      ...(electron?.type ? { electronType: electron.type } : {}),
      ...(electron?.serviceName ? { electronServiceName: electron.serviceName } : {})
    })

    next.set(key, {
      cpuTimeMs: s.cpuTimeMs,
      residentBytes: s.residentBytes,
      sampledAtMs: input.sampledAtMs
    })

    totalCpuPercent += cpuPercent
    totalRss += s.residentBytes
  }

  let starts = input.counters.starts
  let exits = input.counters.exits
  for (const key of next.keys()) if (!input.previous.has(key)) starts += 1
  for (const key of input.previous.keys()) if (!next.has(key)) exits += 1

  return {
    tree,
    objects: [],
    footprint: {
      processCount: tree.length,
      cpuPercent: totalCpuPercent,
      rssBytes: totalRss,
      peakRssBytes: Math.max(input.previousPeakRssBytes, totalRss),
      starts,
      exits
    },
    next,
    counters: { starts, exits }
  }
}
