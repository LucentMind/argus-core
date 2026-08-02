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
  command: string
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
}

export type DiagnosticsSnapshot = {
  readAt: number
  sampleIntervalMs: number
  cores: number
  totalMemoryBytes: number
  footprint: DiagnosticsAggregate
  tree: DiagnosticsProcess[]
  sidecar: SidecarHealth
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
