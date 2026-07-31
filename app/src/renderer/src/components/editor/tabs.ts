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
  mode: 'edit' | 'create'
  /**
   * The open request as minted, and **frozen** — `renameTab` never touches it.
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
  return t.kind === req.kind && t.name === req.name && t.mode === req.mode
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

export function setTabDirty(s: TabsState, id: string, dirty: boolean): TabsState {
  return patch(s, id, (t) => ({ ...t, dirty }))
}

export function setTabView(s: TabsState, id: string, view: TabViewState): TabsState {
  return patch(s, id, (t) => ({ ...t, view }))
}

/**
 * *Edit a copy*: the tab keeps its slot but becomes a different asset.
 *
 * A **fresh id** on purpose (deviation 1). The replacement remounts the surface, which is how it
 * loses the `readOnly` it was built with — no `Compartment` needed, because a read-only tab has
 * no undo history worth preserving. The old view state goes with it: a different file wants a
 * different cursor.
 */
export function replaceTab(s: TabsState, id: string, req: EditorOpenRequest): TabsState {
  const i = s.tabs.findIndex((t) => t.id === id)
  if (i === -1) return s
  const tab = mint(s, req, null)
  const tabs = [...s.tabs]
  tabs[i] = tab
  return { tabs, activeId: tab.id, nextId: s.nextId + 1 }
}

/** What the close handshake reports (spec §3.5). */
export function dirtyCount(s: TabsState): number {
  return s.tabs.filter((t) => t.dirty).length
}
