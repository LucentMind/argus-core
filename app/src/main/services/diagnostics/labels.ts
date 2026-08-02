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

export function resolveLabel(
  _sample: ProcessSample,
  electron: ElectronProcessMetric | undefined,
  sources: LabelSources
): ResolvedLabel | null {
  if (electron) return tierB(electron, sources.windows)
  return null
}
