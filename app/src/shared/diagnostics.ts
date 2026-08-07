/**
 * Wire contract between the Rust resource-monitor sidecar, the main-process
 * DiagnosticsService, and the renderer.
 *
 * This file is imported by the renderer, so it must never import from src/main
 * (tsconfig.web.json excludes src/main; such an import breaks typecheck:web).
 *
 * DIAGNOSTICS_PROTOCOL_VERSION must equal PROTOCOL_VERSION in
 * native/resource-monitor/src/protocol.rs. A mismatch is a hard error on both
 * sides rather than a best-effort parse.
 *
 * v2: dropped `streaming` from the configure command and removed the
 * setStreaming command — the sidecar's slow tick now always delivers its
 * sample instead of discarding it, so `streaming` had nothing left to gate.
 */

export const DIAGNOSTICS_PROTOCOL_VERSION = 2

// ── sidecar → main ───────────────────────────────────────────────────────────

export type ProcessSample = {
  pid: number
  ppid: number
  /** Process start time, ms since the UNIX epoch. Half of every identity key. */
  startTimeMs: number
  runTimeMs: number
  name: string
  command: string
  status: string
  /** Cumulative CPU time across all cores, ms. Deltas are computed in main. */
  cpuTimeMs: number
  residentBytes: number
}

export type SidecarHello = {
  version: number
  type: 'hello'
  sidecarVersion: string
  pid: number
}

export type SidecarSnapshot = {
  version: number
  type: 'snapshot'
  sequence: number
  sampledAtUnixMs: number
  collectionDurationMicros: number
  scannedProcessCount: number
  retainedProcessCount: number
  requestId?: string
  processes: ProcessSample[]
}

export type SidecarErrorEvent = { version: number; type: 'error'; message: string }

export type SidecarEvent = SidecarHello | SidecarSnapshot | SidecarErrorEvent

// ── main → sidecar ───────────────────────────────────────────────────────────

export type SidecarCommand =
  | {
      version: number
      type: 'configure'
      rootPid: number
      sampleIntervalMs: number
    }
  | { version: number; type: 'setSampleInterval'; sampleIntervalMs: number }
  | { version: number; type: 'sampleNow'; requestId: string }
  | { version: number; type: 'shutdown' }

// ── main → renderer ──────────────────────────────────────────────────────────

export type SidecarStatus = 'starting' | 'healthy' | 'degraded' | 'unavailable' | 'disabled'

export type SidecarHealth = {
  status: SidecarStatus
  version: string | null
  restartCount: number
  lastError: string | null
}

export type DiagnosticsProcess = {
  pid: number
  startTimeMs: number
  ppid: number
  /** Depth below the root process; the root itself is 0. */
  depth: number
  name: string
  /** Percent of the whole machine, i.e. already divided by logical core count. */
  cpuPercent: number
  cpuTimeMs: number
  residentBytes: number
  uptimeMs: number
  electronType?: string
  electronServiceName?: string
}

export type DiagnosticsAggregate = {
  processCount: number
  cpuPercent: number
  rssBytes: number
  /** True running maximum of the tree total — not a sum of per-process peaks. */
  peakRssBytes: number
  starts: number
  exits: number
  /** Count of `objects` rows with `orphan: true` — a tier-A process still alive
   *  whose owning Argus object (session, pack app) is gone. */
  orphanCount: number
}

/**
 * What kind of Argus thing a row represents. 'unattributed' is the single
 * synthetic row that absorbs every process no label matched, so the rows always
 * sum to the footprint.
 */
export type DiagnosticsObjectKind =
  | 'electron-window'
  | 'electron-panel'
  | 'electron-internal'
  | 'driver'
  | 'mcp'
  | 'pack-binary'
  | 'pack-app'
  | 'unattributed'

/**
 * One row in the "Argus objects" section: a labeled process plus every
 * unlabeled descendant that rolled up into it.
 *
 * Deliberately carries no command line — a user-configured connector may put a
 * token in its args, and this page is screenshot-and-share territory.
 */
export type DiagnosticsObject = {
  /** `${pid}:${startTimeMs}` of the subtree root, or the literal 'unattributed'. */
  id: string
  kind: DiagnosticsObjectKind
  label: string
  /** kind 'driver' — the provider id, e.g. 'claude-agent-sdk'. */
  provider?: string
  /** kind 'mcp' — the connector instance id. */
  instanceId?: string
  /** Tier A only — opaque owner key of the Argus object that owns this process. */
  owner?: string
  /** True when this process is still alive but its owning Argus object (a session
   *  reaped by AgentService, a pack app whose case was closed) is gone. Always false
   *  for a row with no `owner` — only tier-A rows can be orphaned. */
  orphan: boolean
  /** True when the label came from tier-C command-line inference rather than Electron. */
  inferred: boolean
  /** null for the unattributed row. */
  rootPid: number | null
  processCount: number
  cpuPercent: number
  rssBytes: number
  /** The subtree root's uptime; 0 for the unattributed row. */
  uptimeMs: number
}

export type DiagnosticsSnapshot = {
  readAt: number
  sampleIntervalMs: number
  cores: number
  totalMemoryBytes: number
  footprint: DiagnosticsAggregate
  objects: DiagnosticsObject[]
  tree: DiagnosticsProcess[]
  sidecar: SidecarHealth
}

// ── history ──────────────────────────────────────────────────────────────────

/** 5s buckets × 720 slots = exactly one hour, independent of the sample cadence. */
export const DIAGNOSTICS_BUCKET_MS = 5_000
export const DIAGNOSTICS_BUCKET_COUNT = 720
export const DIAGNOSTICS_RETENTION_MS = DIAGNOSTICS_BUCKET_MS * DIAGNOSTICS_BUCKET_COUNT

/**
 * Slow-tier cadence — the interval the sidecar samples at with the page closed.
 *
 * Declared here rather than only in the service because the RENDERER needs it. A run of
 * empty buckets 15s long means "sampled at the slow rate"; a longer one means "not
 * sampling at all". Only the second of those should break a chart's line, and the
 * renderer cannot import from src/main to find out which is which.
 */
export const DIAGNOSTICS_SLOW_INTERVAL_MS = 15_000

/** Longest empty stretch a chart draws through. Derived, so it stays correct if the
 *  slow-tier cadence ever moves. */
export const DIAGNOSTICS_MAX_BRIDGE_MS = DIAGNOSTICS_SLOW_INTERVAL_MS + DIAGNOSTICS_BUCKET_MS

/**
 * One value per bucket, oldest first.
 *
 * `null` means no sample landed in that bucket, which is NEVER the same thing as a
 * measured zero. Collapsing the two would draw CPU dropping to nothing every ten seconds
 * across the whole slow-tier region — which is precisely the region the timeline exists
 * to show, since it is everything that happened before you opened the page.
 */
export type DiagnosticsSeries = (number | null)[]

export type DiagnosticsHistorySeries = {
  id: string
  label: string
  kind: DiagnosticsObjectKind
  inferred: boolean
  /** False when this object is absent from the most recent recorded sample. */
  live: boolean
  cpuPercent: DiagnosticsSeries
  rssBytes: DiagnosticsSeries
}

export type DiagnosticsHistory = {
  bucketMs: number
  /** Start of the first bucket, ALIGNED to a bucket boundary — never a raw timestamp.
   *  Bucket i covers [from + i*bucketMs, from + (i+1)*bucketMs). */
  from: number
  bucketCount: number
  total: {
    cpuPercent: DiagnosticsSeries
    rssBytes: DiagnosticsSeries
    processCount: DiagnosticsSeries
  }
  objects: DiagnosticsHistorySeries[]
}

/** Narrow projection of Electron's getAppMetrics(), so the pure model never imports electron. */
export type ElectronProcessMetric = {
  pid: number
  creationTimeMs: number
  type: string
  serviceName?: string
}

// ── parsing ──────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * Parse one NDJSON line from the sidecar. Returns null for anything we do not
 * recognise — blank lines, malformed JSON, an unknown type, or a protocol
 * version mismatch. Callers treat null as "ignore this line", never as a crash.
 */
export function parseSidecarEvent(line: string): SidecarEvent | null {
  const trimmed = line.trim()
  if (trimmed === '') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.version !== DIAGNOSTICS_PROTOCOL_VERSION) return null

  switch (parsed.type) {
    case 'hello':
      return typeof parsed.sidecarVersion === 'string' && typeof parsed.pid === 'number'
        ? (parsed as SidecarHello)
        : null
    case 'snapshot':
      return Array.isArray(parsed.processes) && typeof parsed.sequence === 'number'
        ? (parsed as SidecarSnapshot)
        : null
    case 'error':
      return typeof parsed.message === 'string' ? (parsed as SidecarErrorEvent) : null
    default:
      return null
  }
}

/**
 * A command without its version field.
 *
 * The conditional is what makes Omit distribute over the union. A plain
 * `Omit<SidecarCommand, 'version'>` collapses to the keys COMMON to every
 * variant — which is just `type` — so every call site would fail to typecheck.
 */
type WithoutVersion<T> = T extends unknown ? Omit<T, 'version'> : never
export type SidecarCommandInput = WithoutVersion<SidecarCommand>

/** Serialise a command as one NDJSON line, trailing newline included. */
export function encodeSidecarCommand(cmd: SidecarCommandInput): string {
  return JSON.stringify({ version: DIAGNOSTICS_PROTOCOL_VERSION, ...cmd }) + '\n'
}
