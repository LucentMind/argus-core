/** The verbs/protocols a panel may be granted. Read verbs (3a) + write/collab verbs (3b)
 *  + case-file read protocol (3d-1). */
export type PanelPermission =
  | 'getCaseContext'
  | 'requestEvidence'
  | 'readEvidence'
  | 'cite'
  | 'emitFinding'
  | 'sendToAgent'
  | 'readCaseFiles'

/**
 * The IPC channels the SANDBOXED panel preload uses, inlined here as literals
 * rather than imported from `./ipc`. The panel preload runs under sandbox:true,
 * where require() resolves only 'electron' — so its bundle must be a single file
 * with no relative `./chunks/*` require. electron-vite emits such a chunk for any
 * module shared by both preload entries, so the panel preload (this file's
 * `buildPanelApi` + `preload/panel.ts`) must not import the `./ipc` module the
 * main preload also imports. Kept in sync with `IPC` by
 * `preload/__tests__/panelPreloadSelfContained.test.ts`.
 */
export const PANEL_BRIDGE_CHANNELS = {
  getCaseContext: 'panels:get-case-context',
  requestEvidence: 'panels:request-evidence',
  readEvidence: 'panels:read-evidence',
  cite: 'panels:cite',
  emitFinding: 'panels:emit-finding',
  sendToAgent: 'panels:send-to-agent',
  theme: 'panels:theme',
  command: 'panels:command',
  commandResult: 'panels:command-result'
} as const

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

/** Public snapshot of one spawned external app (3c). */
export interface ExternalAppInfo extends PanelKey {
  title: string
  status: 'running' | 'exited'
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
    api.getCaseContext = (): Promise<unknown> => invoke(PANEL_BRIDGE_CHANNELS.getCaseContext)
  }
  if (permissions.includes('requestEvidence')) {
    api.requestEvidence = (query: string): Promise<unknown> =>
      invoke(PANEL_BRIDGE_CHANNELS.requestEvidence, query)
  }
  if (permissions.includes('readEvidence')) {
    api.readEvidence = (evidenceId: number, focusLine?: number): Promise<unknown> =>
      invoke(PANEL_BRIDGE_CHANNELS.readEvidence, evidenceId, focusLine)
  }
  if (permissions.includes('cite')) {
    api.cite = (relPath: string, line: number): Promise<unknown> =>
      invoke(PANEL_BRIDGE_CHANNELS.cite, relPath, line)
  }
  if (permissions.includes('emitFinding')) {
    api.emitFinding = (input: { title: string; markdown: string }): Promise<unknown> =>
      invoke(PANEL_BRIDGE_CHANNELS.emitFinding, input)
  }
  if (permissions.includes('sendToAgent')) {
    api.sendToAgent = (text: string): Promise<unknown> =>
      invoke(PANEL_BRIDGE_CHANNELS.sendToAgent, text)
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
  kind: 'webPanel' | 'externalApp'
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
