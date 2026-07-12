import { IPC } from './ipc'

/** The read-only verbs a 3a panel may be granted. */
export type PanelPermission = 'getCaseContext' | 'requestEvidence' | 'readEvidence'

/** A panel's stable identity within a case. */
export interface PanelKey {
  caseSlug: string
  packId: string
  windowId: string
}

/** Public snapshot of one open panel. */
export interface PanelInfo extends PanelKey {
  title: string
  floated: boolean
}

/** What the MAIN renderer sends to open a panel; title/entry/permissions are filled server-side from windowDecls. */
export interface OpenPanelRequest {
  caseSlug: string
  packId: string
  windowId: string
  focus?: { evidenceId: number; line?: number }
  sessionId?: number | null
}

export type PanelInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>

/**
 * Build the panel-side `window.argus` from the granted permissions. Pure (no
 * electron import) so it is unit-testable; the preload passes ipcRenderer.invoke.
 * An ungranted verb is simply absent.
 */
export function buildPanelApi(permissions: string[], invoke: PanelInvoke): Record<string, unknown> {
  const api: Record<string, unknown> = {}
  if (permissions.includes('getCaseContext')) {
    api.getCaseContext = (): Promise<unknown> => invoke(IPC.panelsGetCaseContext)
  }
  if (permissions.includes('requestEvidence')) {
    api.requestEvidence = (query: string): Promise<unknown> =>
      invoke(IPC.panelsRequestEvidence, query)
  }
  if (permissions.includes('readEvidence')) {
    api.readEvidence = (evidenceId: number, focusLine?: number): Promise<unknown> =>
      invoke(IPC.panelsReadEvidence, evidenceId, focusLine)
  }
  return api
}

/** Bounds for a docked panel's native view, in DIP window coordinates. */
export interface PanelRect {
  x: number
  y: number
  width: number
  height: number
}

/** Renderer-safe declaration of an available webPanel (launcher + "Open in"). */
export interface PanelDecl {
  packId: string
  windowId: string
  title: string
  handles: string[]
}

/** Stable string identity for a panel within a case (matches PanelHost's internal key). */
export function panelKeyStr(k: PanelKey): string {
  return `${k.caseSlug}::${k.packId}::${k.windowId}`
}

/** The panels that render a given artifact type (drives the evidence "Open in" action). */
export function panelHandlesType(decls: PanelDecl[], artifactType: string): PanelDecl[] {
  if (!artifactType) return []
  return decls.filter((d) => d.handles.includes(artifactType))
}
