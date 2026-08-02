import type {
  DiagnosticsObjectKind,
  ElectronProcessMetric,
  ProcessSample
} from '../../../shared/diagnostics'

/**
 * Resolves a raw process sample to an Argus-object label.
 *
 * Pure: every input is a parameter, so no electron import and no I/O. The
 * parent design defines four tiers in strict precedence; this implements B
 * (Electron, authoritative). Tier C (command-line inference) is `inferred: true`
 * and lands in Task 3. Tier A (the spawn-site registry) lands in a later
 * increment and will be consulted before B without changing this function's
 * contract.
 */

/** One Electron-owned window or panel, identified by its OS process id. */
export type WindowDescriptor = {
  osPid: number
  kind: 'main-window' | 'editor-window' | 'panel'
  title?: string
}

/** A configured stdio MCP connector, flattened for command-line matching. */
export type ConnectorCommand = { instanceId: string; command: string; args: string[] }

export type LabelSources = {
  windows: readonly WindowDescriptor[]
  connectors: readonly ConnectorCommand[]
}

export type ResolvedLabel = {
  kind: DiagnosticsObjectKind
  label: string
  provider?: string
  instanceId?: string
  /** True for tier-C guesses, so the renderer can mark them. */
  inferred: boolean
}

function nameOfWindow(w: WindowDescriptor): string {
  switch (w.kind) {
    case 'main-window':
      return 'Main window'
    case 'editor-window':
      return 'Editor window'
    case 'panel':
      return `Panel: ${w.title ?? 'untitled'}`
  }
}

/**
 * Electron can host several same-origin windows in ONE renderer process, so a
 * pid may match more than one descriptor. Joining the names is the honest
 * answer — the row's CPU really does cover both. Letting one silently win
 * would misattribute the other's cost.
 */
function tierBRenderer(pid: number, windows: readonly WindowDescriptor[]): ResolvedLabel {
  const matched = windows.filter((w) => w.osPid === pid)
  if (matched.length === 0)
    return { kind: 'electron-internal', label: 'Renderer process', inferred: false }
  const kind: DiagnosticsObjectKind =
    matched.length === 1 && matched[0].kind === 'panel' ? 'electron-panel' : 'electron-window'
  return { kind, label: matched.map(nameOfWindow).join(' + '), inferred: false }
}

function tierB(electron: ElectronProcessMetric, windows: readonly WindowDescriptor[]): ResolvedLabel {
  switch (electron.type) {
    case 'Browser':
      return { kind: 'electron-internal', label: 'Argus main process', inferred: false }
    case 'GPU':
      return { kind: 'electron-internal', label: 'GPU process', inferred: false }
    case 'Utility':
      return {
        kind: 'electron-internal',
        label: electron.serviceName ? `Utility: ${electron.serviceName}` : 'Utility process',
        inferred: false
      }
    case 'Tab':
      return tierBRenderer(electron.pid, windows)
    default:
      return { kind: 'electron-internal', label: `Electron: ${electron.type}`, inferred: false }
  }
}

/**
 * The default binary names for each driver. Every driver also exposes a
 * user-configurable `cliPath` (shared/drivers.ts), so an operator who points
 * one at a differently-named binary gets an unlabeled row instead. Reading
 * driver settings to widen this is deliberately not done: 2b's spawn-site
 * registry resolves Codex, Cursor, and Grok authoritatively, and Claude and
 * Copilot are heuristic-only by construction (their SDKs hide the pid).
 */
const DRIVER_BASENAMES: Record<string, { provider: string; label: string }> = {
  claude: { provider: 'claude-agent-sdk', label: 'Claude driver' },
  copilot: { provider: 'github-copilot', label: 'Copilot driver' },
  codex: { provider: 'codex', label: 'Codex driver' },
  'cursor-agent': { provider: 'cursor', label: 'Cursor driver' },
  grok: { provider: 'grok', label: 'Grok driver' }
}

const PACK_BINARY_BASENAMES = new Set(['graphify'])

/** Electron descendants that getAppMetrics() omits still announce themselves in argv. */
const ELECTRON_TYPE_FLAGS: [string, string][] = [
  ['--type=renderer', 'Renderer process'],
  ['--type=gpu-process', 'GPU process'],
  ['--type=utility', 'Utility process']
]

/**
 * Executable basename of a command line, lowercased and without `.exe`.
 *
 * Takes the first whitespace-delimited token. An UNQUOTED path containing
 * spaces therefore yields the wrong basename — such a process simply falls
 * through to unlabeled, which is visible in the Unattributed row rather than
 * silently mislabeled.
 */
export function argv0Basename(command: string): string {
  const trimmed = command.trim()

  // Check if the command starts with a quote and extract the quoted string
  let first: string
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0]
    const closeIdx = trimmed.indexOf(quote, 1)
    if (closeIdx !== -1) {
      first = trimmed.substring(0, closeIdx + 1)
    } else {
      first = trimmed.split(/\s+/)[0] ?? ''
    }
  } else {
    first = trimmed.split(/\s+/)[0] ?? ''
  }

  const unquoted = first.replace(/^["']+|["']+$/g, '')
  const base = unquoted.split(/[\\/]/).pop() ?? ''
  return base.toLowerCase().replace(/\.exe$/, '')
}

function tierC(sample: ProcessSample): ResolvedLabel | null {
  const base = argv0Basename(sample.command)

  const driver = DRIVER_BASENAMES[base]
  if (driver)
    return {
      kind: 'driver',
      label: driver.label,
      provider: driver.provider,
      inferred: true
    }

  if (PACK_BINARY_BASENAMES.has(base))
    return { kind: 'pack-binary', label: base, inferred: true }

  for (const [flag, label] of ELECTRON_TYPE_FLAGS)
    if (sample.command.includes(flag))
      return { kind: 'electron-internal', label, inferred: true }

  return null
}

export function resolveLabel(
  sample: ProcessSample,
  electron: ElectronProcessMetric | undefined,
  sources: LabelSources
): ResolvedLabel | null {
  if (electron) return tierB(electron, sources.windows)
  return tierC(sample)
}
