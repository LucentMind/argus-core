import type { AuthoringKind } from '../../../../shared/authoringIpc'
import type { EditorOpenRequest, TabViewState } from '../../../../shared/editorIpc'

/**
 * One open asset. Spec §6.1.
 *
 * `id` is synthetic and stable for the life of the tab — deliberately **not** derived from
 * kind/name/mode, which is what `EditorApp` keyed on through Increment 3. A create-mode tab
 * renames as the user types the name field, and a name-derived key would remount the surface on
 * every keystroke, destroying the undo history this whole spec exists to protect (§1.1.1).
 *
 * There is no document here, and there is no cursor either while the tab is open: every tab
 * stays mounted, so CodeMirror holds both. `view` is only populated for persistence and for a
 * restored tab that has not been looked at yet.
 */
export interface Tab {
  id: string
  kind: AuthoringKind
  /** The **live** name: a create-mode tab renames as the user types the name field, and the
   *  strip shows this. */
  name: string
  /**
   * What this tab IS now, which is not always what it was opened as: a create-mode tab becomes
   * an edit-mode one the moment its first save lands (`markTabSaved`). Read by `sameAsset` and by
   * the persisted report — deliberately **not** by `AssetTab`, which reads `req.mode`.
   */
  mode: 'edit' | 'create'
  /**
   * The open request as minted, and **frozen** — neither `renameTab` nor `markTabSaved` touches
   * it.
   *
   * `AssetTab` resolves disk and draft off this. If it followed `name`, every keystroke in the
   * create-mode name field would re-read disk, re-resolve the draft and fight the buffer.
   */
  req: EditorOpenRequest
  dirty: boolean
  view: TabViewState | null
}

export interface TabsState {
  tabs: Tab[]
  activeId: string | null
  /** Monotonic id source. In state rather than a module counter so every function here stays
   *  pure and the tests are deterministic. */
  nextId: number
}

export const emptyTabs: TabsState = { tabs: [], activeId: null, nextId: 1 }

/**
 * Stable DOM ids for the WAI-ARIA tabs pattern (spec §6.1), derived from a tab's synthetic `id`
 * rather than re-invented separately in `TabBar` (the `role="tab"`) and `EditorApp` (the
 * `role="tabpanel"`) — one naming convention in one place is what keeps `aria-controls` and
 * `aria-labelledby` pointed at each other instead of drifting apart under an edit to either file.
 */
export function tabElementId(id: string): string {
  return `tab-${id}`
}

export function tabPanelElementId(id: string): string {
  return `tabpanel-${id}`
}

/** Spec §6.1's "one tab per asset". Reads the tab's CURRENT name, so a create-mode rename is
 *  immediately visible to it. */
function sameAsset(t: Tab, req: EditorOpenRequest): boolean {
  return (
    t.kind === req.kind &&
    t.name === req.name &&
    t.mode === req.mode &&
    // `draftId` is part of a create-mode tab's IDENTITY, not an extra field. Every "New skill"
    // opens as the same kind/name/mode, and resuming a specific draft from the resumable-drafts
    // banner re-sends that same triple with a different id (drafts are id-keyed — see `keyOf` in
    // main/services/drafts.ts). Without this clause the resume would dedupe onto the tab already
    // open and silently do nothing, which is the single most likely case.
    // Compared against the FROZEN request: `renameTab` moves `name`, never `req`.
    (t.req.draftId ?? null) === (req.draftId ?? null)
  )
}

function mint(s: TabsState, req: EditorOpenRequest, view: TabViewState | null): Tab {
  return {
    id: `t${s.nextId}`,
    kind: req.kind,
    name: req.name,
    mode: req.mode,
    req,
    dirty: false,
    view
  }
}

/** Add the asset, or focus it if it is already open. */
export function openTab(
  s: TabsState,
  req: EditorOpenRequest,
  view: TabViewState | null = null
): TabsState {
  const existing = s.tabs.find((t) => sameAsset(t, req))
  if (existing) return { ...s, activeId: existing.id }
  const tab = mint(s, req, view)
  return { tabs: [...s.tabs, tab], activeId: tab.id, nextId: s.nextId + 1 }
}

export function closeTab(s: TabsState, id: string): TabsState {
  const i = s.tabs.findIndex((t) => t.id === id)
  if (i === -1) return s
  const tabs = s.tabs.filter((t) => t.id !== id)
  if (s.activeId !== id) return { ...s, tabs }
  // Right-hand neighbour, then left, then nothing — the behaviour of every tabbed editor.
  const next = tabs[i] ?? tabs[i - 1] ?? null
  return { ...s, tabs, activeId: next?.id ?? null }
}

export function activateTab(s: TabsState, id: string): TabsState {
  return s.tabs.some((t) => t.id === id) ? { ...s, activeId: id } : s
}

function patch(s: TabsState, id: string, f: (t: Tab) => Tab): TabsState {
  if (!s.tabs.some((t) => t.id === id)) return s
  return { ...s, tabs: s.tabs.map((t) => (t.id === id ? f(t) : t)) }
}

export function renameTab(s: TabsState, id: string, name: string): TabsState {
  return patch(s, id, (t) => ({ ...t, name }))
}

/**
 * A create-mode tab whose save has landed. From here on it is a tab over a file that exists.
 *
 * Nothing else flips `mode`, and leaving it at `'create'` after a save is two bugs at once:
 *
 * 1. `sameAsset` includes `mode`, so clicking *Edit* on the just-created asset in the Library
 *    mints a SECOND tab over the same file. Both stay mounted, and `draftKey` is `kind:name`
 *    only (main/services/drafts.ts) — so the two share one draft file and stomp each other, and
 *    a save from one leaves the other with a stale `baseHash` and a conflict banner describing
 *    nothing.
 * 2. The persisted set carries `mode: 'create'`, so a restart replays create mode over a file
 *    that now holds real content: `AssetTab` resolves disk into a create-mode `AssetPane` whose
 *    `lastSaved` is `null` again. That is exactly the state `AssetPane.renameCreate`'s
 *    `lastSaved === null` guard exists to prevent — one keystroke in the name field replaces the
 *    saved body with boilerplate and files that boilerplate as the draft.
 *
 * **`req` deliberately does NOT flip with it.** `AssetTab` resolves disk and the draft off `req`,
 * and its resolve effect keys on `req`'s kind/name/mode. Moving `req` here would re-run that
 * resolve underneath a LIVE CodeMirror that already owns the document — re-reading disk and
 * re-resolving the draft, so the save-then-keep-typing path would raise a "Restored unsaved
 * draft" banner over a buffer the user is still in, and the pane's `mode` prop would swap the
 * name field out from under them mid-edit. That is precisely what `req`'s frozen contract exists
 * to stop (see the note on {@link Tab.req}). `mode` on the tab is a different fact from
 * `req.mode`: the first is what the tab holds *now* (dedupe + persistence), the second is the
 * request that mounted the pane and stays true for that pane's whole life. The next window gets
 * the corrected mode because the report reads `t.mode`.
 *
 * `name` is a parameter rather than read off the tab so this is correct however it is ordered
 * against `renameTab`: a create-mode save adopts the name the write actually used.
 */
export function markTabSaved(s: TabsState, id: string, name: string): TabsState {
  return patch(s, id, (t) => (t.mode === 'create' ? { ...t, mode: 'edit', name } : t))
}

export function setTabDirty(s: TabsState, id: string, dirty: boolean): TabsState {
  return patch(s, id, (t) => ({ ...t, dirty }))
}

export function setTabView(s: TabsState, id: string, view: TabViewState): TabsState {
  return patch(s, id, (t) => ({ ...t, view }))
}

/**
 * *Edit a copy*: the tab keeps its slot but becomes a different asset.
 *
 * A **fresh id** on purpose (deviation 1). The replacement re-resolves the asset from disk under
 * a new `AssetTab`, and the old view state goes with it: a different file wants a different
 * cursor.
 *
 * The remount is **not** what makes the new pane editable, though it reads that way. `readOnly`
 * is re-derived from the tier maps, and after a claim those can still be pre-claim — so the
 * replacement pane can mount read-only. `CodeSurface` reconfigures `readOnly` through a
 * compartment when the `refsync:changed` / `skills:changed` broadcast lands, which is what
 * releases it; without that this depended on main happening to broadcast before the claim IPC
 * returned.
 *
 * Spec §6.1's "one tab per asset" binds here too, and it is not `openTab`'s business alone: fork
 * a read-only skill onto a name that is ALREADY open in another tab and minting would give two
 * tabs over one file — the same shared-draft-key and stale-`baseHash` damage as a duplicated
 * create-mode tab (see {@link markTabSaved}). The persisted set would carry the duplicate too,
 * and restore folds it back through `openTab`, so the tab COUNT would change across a restart.
 * So a replacement that matches an open tab **folds into it**: the replaced slot closes and the
 * tab that already holds the asset becomes active.
 */
export function replaceTab(s: TabsState, id: string, req: EditorOpenRequest): TabsState {
  const i = s.tabs.findIndex((t) => t.id === id)
  if (i === -1) return s
  // `t.id !== id` is load-bearing: a reference CLAIM replaces a tab with its own kind/name/mode,
  // so without it every claim would match itself and merely close the tab.
  const existing = s.tabs.find((t) => t.id !== id && sameAsset(t, req))
  if (existing) return { ...s, tabs: s.tabs.filter((t) => t.id !== id), activeId: existing.id }
  const tab = mint(s, req, null)
  const tabs = [...s.tabs]
  tabs[i] = tab
  return { tabs, activeId: tab.id, nextId: s.nextId + 1 }
}

/** What the close handshake reports (spec §3.5). */
export function dirtyCount(s: TabsState): number {
  return s.tabs.filter((t) => t.dirty).length
}
