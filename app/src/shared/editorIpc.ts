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
  closeResponse: 'editor:close-response',
  /** renderer → main: the buffer moved. Main debounces and persists (spec §4.2). */
  draftChanged: 'editor:draft-changed',
  /** main → renderer: the draft is on disk. Persist-before-adopt — the UI claims nothing
   *  before this arrives. */
  draftSaved: 'editor:draft-saved',
  /** renderer → main: the draft for an asset, or null. */
  draftRead: 'editor:draft-read',
  /** renderer → main: delete it (saved, or discarded by hand). */
  draftDiscard: 'editor:draft-discard',
  /** renderer → main: every draft currently known, for the resumable-drafts banner. */
  draftList: 'editor:draft-list'
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

/**
 * One autosaved buffer. Written to `argusHome/drafts/<key>.json`, where the key is a hash of
 * kind+name (see `draftKey`) — so the real identity lives here in the body.
 */
export interface DraftRecord {
  kind: AuthoringKind
  name: string
  mode: 'edit' | 'create'
  content: string
  /** Hash of the disk bytes this buffer was derived from. null in create mode, and it is what
   *  makes staleness detectable at open (spec §4.1). */
  baseHash: string | null
  updatedAt: string
}

export interface DraftChange extends Omit<DraftRecord, 'updatedAt'> {
  /** Set when the create-mode name field moved: the store re-keys so the draft follows the
   *  name instead of stranding under the old one (spec §4.5). */
  replaces?: { kind: AuthoringKind; name: string }
}

export interface DraftRef {
  kind: AuthoringKind
  name: string
}

/** main → renderer, after the bytes are on disk. */
export interface DraftSaved {
  kind: AuthoringKind
  name: string
  updatedAt: string
}
