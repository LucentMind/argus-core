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
  draftList: 'editor:draft-list',
  /** renderer → main: adopt a legacy (pre-draftId) create-mode draft onto its id-keyed record,
   *  atomically — see `DraftStore.adopt`. Replaces a renderer-driven `draftChanged` +
   *  `discardDraft` pair, which could delete the only on-disk copy before the debounced write
   *  that was meant to replace it ever landed. */
  draftAdopt: 'editor:draft-adopt'
} as const

export interface EditorOpenRequest {
  kind: AuthoringKind
  name: string
  mode: 'edit' | 'create'
  /** Set only when resuming an existing create-mode draft: carries its stable id forward so the
   *  resumed tab finds the same draft by id instead of minting a fresh one. */
  draftId?: string
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
 * One autosaved buffer. Written to `argusHome/drafts/<key>.json`, where the key is either a hash
 * of kind+name (edit mode, `draftKey`) or of `draftId` (create mode) — see `keyOf` in
 * main/services/drafts.ts. Either way, the real identity lives here in the body.
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
  /** Stable id for a create-mode draft, minted once when its tab opens (see `keyOf` in
   *  main/services/drafts.ts) — the record's real key in create mode, independent of `name`.
   *  Absent for edit-mode drafts, whose identity is the file itself, and absent on a create-mode
   *  record written before this field existed (back-compat; adopted on open, AssetTab.tsx). */
  draftId?: string
}

export type DraftChange = Omit<DraftRecord, 'updatedAt'>

/**
 * How a draft is addressed. Edit-mode identity is the file (kind+name); create-mode identity is
 * the stable `draftId` minted when its tab opened, independent of the (mutable) typed name — see
 * `keyOf` in main/services/drafts.ts for why the two schemes differ.
 */
export type DraftRef = { kind: AuthoringKind; name: string } | { draftId: string }

/** main → renderer, after the bytes are on disk. */
export interface DraftSaved {
  kind: AuthoringKind
  name: string
  updatedAt: string
}

/**
 * renderer → main: adopt a legacy (pre-draftId) create-mode draft. `legacy` is the old kind+name
 * key to discard; `change` is the record to write under its new `draftId` key — `draftId` is
 * required here (unlike `DraftChange`) because adoption only ever moves a record *onto* the id
 * scheme, never off it.
 */
export interface DraftAdoptRequest {
  legacy: { kind: AuthoringKind; name: string }
  change: DraftChange & { draftId: string }
}
