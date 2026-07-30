import type { AuthoringKind } from './authoringIpc'

/** Channels owned by the editor window. Kept out of `ipc.ts` so the editor's
 *  surface stays legible as one unit. */
export const EDITOR_IPC = {
  /** renderer → main: open (or focus) the editor window on an asset. */
  open: 'editor:open',
  /** main → renderer: add a tab for this asset. */
  openTab: 'editor:open-tab',
  /** renderer → main: how many open assets have unsaved changes. */
  dirtyState: 'editor:dirty-state',
  /** main → renderer: the user tried to close the window while work was dirty. */
  closeRequested: 'editor:close-requested',
  /** renderer → main: the answer to `closeRequested`. */
  closeResponse: 'editor:close-response'
} as const

export interface EditorOpenRequest {
  kind: AuthoringKind
  name: string
  mode: 'edit' | 'create'
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Wide enough for the split preview that lands in Increment 3. */
export const EDITOR_DEFAULT_SIZE = { width: 1100, height: 780 } as const

/** Below this the window is not usefully editable. */
export const EDITOR_MIN_SIZE = { width: 720, height: 520 } as const
