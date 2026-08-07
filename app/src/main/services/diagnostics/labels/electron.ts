import type { DiagnosticsObjectKind, ElectronProcessMetric } from '../../../../shared/diagnostics'
import type { ResolvedLabel, WindowDescriptor } from './types'

function nameOfWindow(w: WindowDescriptor): string {
  switch (w.kind) {
    case 'main-window':
      return 'Main window'
    case 'editor-window':
      return 'Editor window'
    case 'panel':
      // `??` does not cover the empty string, and an empty title IS reachable
      // here: the collector's `panelTitle !== null` check deliberately admits
      // '' (see index.ts's titleForWebContents usage), which would otherwise
      // render as the empty "Panel: ".
      return `Panel: ${w.title || 'untitled'}`
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

export function tierB(
  electron: ElectronProcessMetric,
  windows: readonly WindowDescriptor[]
): ResolvedLabel {
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
