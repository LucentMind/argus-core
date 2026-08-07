import type { DiagnosticsObjectKind } from '../../../../shared/diagnostics'

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
