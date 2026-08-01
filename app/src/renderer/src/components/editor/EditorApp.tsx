import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssetTab } from './AssetTab'
import { TabBar } from './TabBar'
import { CommandPalette } from './CommandPalette'
import { ConfirmHost } from '../ConfirmHost'
import { alert, confirm } from '../../lib/confirmStore'
import { ForkSkillDialog } from '../settings/ForkSkillDialog'
import { ReadOnlyNotice } from './ReadOnlyNotice'
import { drainEditorMessages } from './editorBootstrap'
import { useAssetTiers } from '../../lib/assetTiers'
import { useEditorAssets } from '../../lib/editorAssets'
import { isAssetEditable, isGeneratedAsset } from '../../../../shared/assetEditable'
import { TIER_LABELS, type TrustTier } from '../../../../shared/trustTiers'
import {
  buildCommands,
  commandForEvent,
  type AssetPaneHandle,
  type Command,
  type PaneCommandState
} from '../../lib/commands'
import {
  activateTab,
  closeTab,
  cycleTab,
  dirtyCount,
  emptyTabs,
  markTabSaved,
  openTab,
  renameTab,
  replaceTab,
  setTabDirty,
  setTabView,
  tabElementId,
  tabPanelElementId,
  type Tab,
  type TabsState
} from './tabs'
import type { AuthoringKind } from '../../../../shared/authoringIpc'
import type { TierLookup } from '../../../../shared/assetEditable'
import type { AssetRow } from '../../lib/palette'
import type { PersistedTabs, TabViewState } from '../../../../shared/editorIpc'

/**
 * The stable "this tab offers nothing" value for every tab that is not the active one (see
 * `commands` below and the `.map` call site in `EditorApp`). Frozen and module-level, not
 * `undefined`: `AssetPane`'s `cmdFor` treats an absent `commands` prop (`undefined`) as "no host
 * at all, fall back to local expressions" — the shape its own standalone tests mount with — and
 * conflating "the window supplied an empty list" with that would silently resurrect the local
 * fallback (see finding 2's drift) for every inactive tab. An empty array keeps the two
 * distinguishable: every inactive pane's buttons render as omitted (no descriptor found), not
 * locally recomputed, exactly as if the (invisible, hidden) tab had a working registry that simply
 * routes nothing to it.
 */
const NO_COMMANDS: readonly Command[] = Object.freeze([])

interface TabPaneProps {
  tab: Tab
  active: boolean
  /** Computed once per render in the `.map` below, off `useAssetTiers`/`isAssetEditable` — kept
   *  out of this component so its own re-renders (which can be frequent; see the identity-
   *  stability note above) never re-run that lookup. */
  readOnly: boolean
  /** Raw tier, for `ReadOnlyNotice`'s explanation and the status-bar badge below. `undefined`
   *  (unresolved) and `null` (untagged) both mean "no badge, and never read-only" — see
   *  assetTiers.ts. */
  tier: TierLookup
  /** Whether this asset is generated and should open read-only. Computed per tab like `readOnly`. */
  generated: boolean
  onDirtyChange: (id: string, dirty: boolean) => void
  onNameChange: (id: string, name: string) => void
  /** A save landed. Flips a create-mode tab to edit mode — see `markTabSaved` in tabs.ts. */
  onSaved: (id: string, name: string) => void
  onViewStateChange: (id: string, view: TabViewState) => void
  /** *Edit a copy* (spec §6.2). Takes the same primitives as the other callbacks above, not the
   *  whole `Tab` — see the comment on `handleEditCopy`. */
  onEditCopy: (id: string, kind: AuthoringKind, name: string) => void
  /** What the ACTIVE pane reports upward, tagged with the tab it came from — see the comment on
   *  `reported` in `EditorApp`. */
  onCommandState: (id: string, s: PaneCommandState) => void
  /** The window's way into this pane's imperative handle. A callback ref, so React calls it with
   *  `null` on unmount — see the comment on `handlePaneRef` below. */
  registerPane: (id: string, h: AssetPaneHandle | null) => void
  /** The window's registry (spec §6.4), rebuilt whenever the active pane reports. Already
   *  resolved to the right value BEFORE this component sees it: the `.map` call site in
   *  `EditorApp` passes the live, constantly-rebuilt array only for the tab whose id matches
   *  `state.activeId`, and the frozen `NO_COMMANDS` to every other tab. That split has to happen
   *  there, not in here — `TabPane` is `memo`-wrapped, and by the time a ternary inside its body
   *  ran, the memo's shallow prop comparison would already have seen a fresh array identity on
   *  `commands` for every mounted tab and bailed out of skipping the re-render for all of them, not
   *  just the active one. See the file-level comment on `TabPane` for the OOM-class bug this
   *  guards against. */
  commands: readonly Command[]
}

/**
 * One tab's slot. Pulled out of `EditorApp`'s `.map` so each of `AssetTab`'s callback props gets
 * an identity that is stable across `EditorApp` re-renders, not a fresh closure every time.
 *
 * This is not about `setTabDirty`/`patch` returning a new `TabsState` object — making `patch`
 * identity-preserving still OOMs on the very first keystroke, and one tab is enough to trigger
 * it. The real driver is `AssetPane`'s **identity-keyed unmount cleanup**
 * (`useEffect(() => () => onDirtyChange(false), [onDirtyChange])`) alongside its **dirty-report
 * effect** (`useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])`) — cited by name
 * rather than by line, because the line numbers drifted twice and were stale inside the very
 * commit that wrote them. A `.map`-inline `(d) => onDirtyChange(t.id, d)` is a new function on
 * every `EditorApp` render, and on every such change React runs the cleanup (writing `false`) and
 * then the report setup (writing `true`) — two genuine `dirty` transitions per render, each
 * triggering another `EditorApp` render, which mints another new callback. No amount of memoizing
 * `patch` absorbs that; only a stable `onDirtyChange` identity does. Binding `tab.id` inside this
 * component via `useCallback` is what supplies that stability, so neither effect re-fires except
 * when `dirty` itself actually flips.
 *
 * **`memo` on top of that** (not instead of it). Every cursor move calls `onViewStateChange` →
 * `setTabView` → a new `TabsState` → an `EditorApp` re-render, which without this re-renders
 * EVERY mounted pane. `viewMode` is a global pref, so once the user picks Split or Preview there
 * is a `PreviewPane` mounted in all N tabs and react-markdown re-parses every hidden tab's
 * document on every keystroke. A bare `memo` is correct and complete here because both of its
 * preconditions hold: `patch` (tabs.ts) preserves the object identity of every tab it did not
 * touch, and all seven callbacks below arrive from `useCallback`s in `EditorApp` that never
 * re-create (`onEditCopy` moves only when a tier list is re-broadcast). Do not "simplify" either
 * of those into an inline arrow. The two newest — `onCommandState` and `registerPane` — get the
 * exact same treatment for the exact same reason: an inline `.map` arrow for either would be a
 * fresh identity every render, and `registerPane` in particular is a callback REF, so a fresh
 * identity every render would call it with `null` then a new handle on every single keystroke
 * anywhere in the window.
 */
const TabPane = memo(function TabPane({
  tab,
  active,
  readOnly,
  tier,
  generated,
  onDirtyChange,
  onNameChange,
  onSaved,
  onViewStateChange,
  onEditCopy,
  onCommandState,
  registerPane,
  commands
}: TabPaneProps): React.JSX.Element {
  const handleDirtyChange = useCallback(
    (d: boolean) => onDirtyChange(tab.id, d),
    [tab.id, onDirtyChange]
  )
  const handleNameChange = useCallback(
    (n: string) => onNameChange(tab.id, n),
    [tab.id, onNameChange]
  )
  const handleSaved = useCallback((n: string) => onSaved(tab.id, n), [tab.id, onSaved])
  const handleViewStateChange = useCallback(
    (v: TabViewState) => onViewStateChange(tab.id, v),
    [tab.id, onViewStateChange]
  )
  // Same treatment as the callbacks above: bound on `tab.id`/`tab.kind`/`tab.name` rather than
  // closing over `tab` itself. `tab` is not identity-stable across a dirty toggle (`patch` in
  // tabs.ts spreads a fresh object for the same id on every keystroke elsewhere in the window),
  // so closing over it here would defeat the whole point of pulling `TabPane` out of the `.map` —
  // see the file-level comment on this component.
  //
  // `tab.name` and not `tab.req.name`: `req` is frozen at mint, so after a create-mode tab is
  // saved (and `markTabSaved` flips it to edit mode) the two name DIFFERENT assets — and this is
  // reachable then, because an edit-mode tab gets a real tier lookup. Forking or claiming
  // `req.name` there would act on whatever the tab was opened as, not on the file it holds. This
  // costs no stability: a create-mode tab renames on every keystroke, but it is never read-only,
  // so nothing that consumes this callback is even rendered.
  const handleEditCopy = useCallback(
    () => onEditCopy(tab.id, tab.kind, tab.name),
    [tab.id, tab.kind, tab.name, onEditCopy]
  )
  const handleCommandState = useCallback(
    (s: PaneCommandState) => onCommandState(tab.id, s),
    [tab.id, onCommandState]
  )
  // A CALLBACK ref, so React hands us `null` on unmount and the map cannot leak a handle for a
  // tab that is gone. Bound on `tab.id` for the same identity-stability reason as every other
  // callback here: an inline arrow would re-register on every EditorApp render.
  const handlePaneRef = useCallback(
    (h: AssetPaneHandle | null) => registerPane(tab.id, h),
    [tab.id, registerPane]
  )
  // `Chip`-style provenance badge (spec §5.5): the Library's one-word labels, not the raw tier
  // string. An unresolved or untagged tier gets no badge — a raw slug in the status bar would
  // read as a bug, and neither case is ever read-only anyway (see assetEditable.ts).
  const tierLabel = tier && tier in TIER_LABELS ? TIER_LABELS[tier as TrustTier] : undefined

  return (
    // The whole class string swaps rather than toggling the `hidden` ATTRIBUTE: `[hidden]`
    // is a UA rule at effectively zero specificity and `.flex` beats it, so a
    // "hidden" tab would render on top of the active one. Tailwind's `hidden` utility is
    // `display: none`, which also takes the subtree out of the a11y tree — no
    // `aria-hidden`, which on a subtree containing the focused element would be a bug.
    <div
      id={tabPanelElementId(tab.id)}
      role="tabpanel"
      aria-labelledby={tabElementId(tab.id)}
      className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
    >
      {readOnly && (
        <ReadOnlyNotice
          kind={tab.kind}
          // `tab.name`, matching the tier this notice is explaining — see `handleEditCopy`.
          name={tab.name}
          tier={tier ?? null}
          generated={generated}
          onEditCopy={handleEditCopy}
        />
      )}
      <AssetTab
        // `tab.req`, NOT a request rebuilt from `tab.name`. The two differ exactly while a
        // create-mode tab is being renamed, and rebuilding would re-run AssetTab's resolve
        // effect on every keystroke in the name field — re-reading disk and re-resolving the
        // draft under a live buffer. See tabs.ts's note on `req`.
        req={tab.req}
        active={active}
        readOnly={readOnly}
        tier={tierLabel}
        initialViewState={tab.view}
        onDirtyChange={handleDirtyChange}
        onNameChange={handleNameChange}
        onSaved={handleSaved}
        onViewStateChange={handleViewStateChange}
        onCommandState={handleCommandState}
        paneRef={handlePaneRef}
        // Already the right value for this tab by the time it gets here — see the doc comment on
        // the `commands` prop above. No ternary needed (or safe) at this point in the tree.
        commands={commands}
      />
    </div>
  )
})

/**
 * Root of the editor window. Owns window-level concerns only — which assets are open, which one
 * is on screen, telling main how much work is dirty, and answering the close handshake.
 * Everything about an asset, including its draft, belongs to its `AssetTab`.
 *
 * **Every tab stays mounted.** Inactive ones are hidden with a class, never unmounted, so undo
 * history, cursor, scroll and a running assist all survive a tab switch with no per-tab document
 * state anywhere in this file. That is the whole design (spec §6.1): the only thing this
 * component persists per tab is where the cursor was, and only so a restart can restore it.
 */
export function EditorApp(): React.JSX.Element {
  const [state, setState] = useState<TabsState>(emptyTabs)
  const dirty = dirtyCount(state)
  const tierOf = useAssetTiers()
  // Only a skill fork needs a name-entry dialog (a claim keeps its name) — `tier` here is the
  // skill triple `ForkSkillDialog` expects, and a read-only skill is never `user` (assetEditable.ts).
  const [forking, setForking] = useState<{
    id: string
    name: string
    tier: 'bundled' | 'hivemind'
  } | null>(null)

  // Read across the async confirm in the close handler so the answer reflects the tab set now,
  // not when the subscription was created.
  const dirtyRef = useRef(dirty)
  useEffect(() => {
    dirtyRef.current = dirty
    window.argus.editor.setDirty(dirty)
  }, [dirty])

  const { rows: assetRows, refresh: refreshAssets } = useEditorAssets()
  /** `''` when closed is not a valid closed-state — an empty query is a legitimate OPEN palette.
   *  `null` is closed; a string is open, and its content picks the mode. */
  const [palette, setPalette] = useState<string | null>(null)

  /**
   * Every mounted pane's handle, keyed by tab id. A ref and not state: this is read at press
   * time from inside a command's `run()`, never during render — which is the whole reason the
   * registry takes state and actions through separate channels (see lib/commands.ts).
   */
  const handles = useRef(new Map<string, AssetPaneHandle>())
  const registerPane = useCallback((id: string, h: AssetPaneHandle | null): void => {
    if (h) handles.current.set(id, h)
    else handles.current.delete(id)
  }, [])

  /**
   * What the ACTIVE pane last reported. One slot, tagged with the tab it came from, rather than
   * a map: a tab switch would otherwise leave the toolbar reading the previous tab's state until
   * the new pane's first report lands, and the tag makes that window resolve to `null` (every
   * pane-scoped command disabled) instead of to a lie.
   */
  const [reported, setReported] = useState<{ id: string; state: PaneCommandState } | null>(null)
  const onCommandState = useCallback((id: string, s: PaneCommandState): void => {
    setReported({ id, state: s })
  }, [])
  const paneState = reported && reported.id === state.activeId ? reported.state : null

  // Read across event handlers, so it must reflect the tab set NOW rather than at subscribe
  // time — the same discipline `dirtyRef` above already uses, for the same reason.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const activePane = useCallback((): AssetPaneHandle | null => {
    const id = stateRef.current.activeId
    return id ? (handles.current.get(id) ?? null) : null
  }, [])
  const dirtyPanes = useCallback(
    (): AssetPaneHandle[] =>
      stateRef.current.tabs
        .filter((t) => t.dirty)
        .map((t) => handles.current.get(t.id))
        .filter((h): h is AssetPaneHandle => h !== undefined),
    []
  )

  const openPalette = useCallback(
    (prefix: string): void => {
      // Re-read as it opens: the Drafts section is the part that goes stale fastest, and a draft
      // write is debounced in main rather than broadcast.
      refreshAssets()
      setPalette(prefix)
    },
    [refreshAssets]
  )

  const commands = useMemo(
    () =>
      buildCommands({
        pane: paneState,
        activePane,
        dirtyPanes,
        dirtyCount: dirty,
        tabCount: state.tabs.length,
        window: {
          quickOpen: () => openPalette(''),
          commandPalette: () => openPalette('>'),
          closeTab: () => setState((s) => (s.activeId ? closeTab(s, s.activeId) : s)),
          nextTab: () => setState((s) => cycleTab(s, 1)),
          prevTab: () => setState((s) => cycleTab(s, -1))
        }
      }),
    [paneState, activePane, dirtyPanes, dirty, state.tabs.length, openPalette]
  )

  /**
   * The window's ONE keymap, and the replacement for the per-pane `window` listener that used to
   * live in `AssetPane`.
   *
   * `defaultPrevented` is the handshake with CodeMirror's own keymap: that keymap sets it
   * whenever it handled the key, so a chord both of them know (Ctrl+S, Ctrl+±, Alt+Z) fires once
   * while the editor has focus and still works when it does not — which is the case Preview mode
   * creates, since it marks the editor subtree `inert` and focus falls to `<body>`.
   *
   * A matched-but-DISABLED command still swallows the key. Letting a disabled Ctrl+W fall
   * through hands it to Electron, which closes the window.
   *
   * The listener is registered once and reads the current descriptors through a ref: rebuilding
   * it on every `commands` identity would re-register on every keystroke.
   */
  const commandsRef = useRef(commands)
  useEffect(() => {
    commandsRef.current = commands
  }, [commands])
  const paletteOpenRef = useRef(false)
  useEffect(() => {
    paletteOpenRef.current = palette !== null
  }, [palette])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      // The palette owns the keyboard while it is up, including its own Escape handling.
      if (paletteOpenRef.current) return
      const cmd = commandForEvent(commandsRef.current, e)
      if (!cmd) return
      e.preventDefault()
      if (cmd.enabled) cmd.run()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const pickAsset = useCallback((row: AssetRow): void => {
    if (row.draft) {
      // A create draft resumes under its own id (drafts are id-keyed — `keyOf` in
      // main/services/drafts.ts); an ORPHANED edit draft has no file left, so it opens in edit
      // mode and `AssetTab`'s resolve finds the draft with no disk behind it.
      setState((s) =>
        openTab(s, {
          kind: row.draft!.kind,
          name: row.name,
          mode: row.draft!.mode,
          ...(row.draft!.draftId ? { draftId: row.draft!.draftId } : {})
        })
      )
      return
    }
    setState((s) => openTab(s, { kind: row.kind as AuthoringKind, name: row.name, mode: 'edit' }))
  }, [])

  const discardDraftRow = useCallback(
    (row: AssetRow): void => {
      if (!row.draft) return
      void (async () => {
        try {
          await window.argus.editor.discardDraft(
            row.draft!.draftId
              ? { draftId: row.draft!.draftId }
              : { kind: row.draft!.kind, name: row.name }
          )
        } catch (e) {
          await alert({
            title: `Could not discard the draft for "${row.name}".`,
            message: e instanceof Error ? e.message : String(e)
          })
          return
        }
        refreshAssets()
      })()
    },
    [refreshAssets]
  )

  /**
   * The window's ONE inbound message consumer. Drains the module-scope queue (see
   * editorBootstrap.ts) — NOT raw `onOpenTab`/`onRestoreTabs` subscriptions: main flushes its
   * queued messages on `did-finish-load`, which can precede React's passive effects, so
   * subscribing here alone would re-open the dropped-first-message bug that Increment 1 fixed
   * on the main side.
   *
   * **One effect, dispatching by tag, on purpose.** Restore is a window-CREATION event (spec:
   * main sends it only when `open()` creates the window, never when it merely focuses a live
   * one), sent BEFORE the `openTab` that caused the creation. Folding each restored tab through
   * `openTab` — rather than replacing `state` outright — is what makes that ordering pay off:
   * the renderer dedupes on open, so if the asset that triggered the window's creation is
   * already in the restored set, the later `openTab` focuses it instead of adding a duplicate,
   * and the restored tab ORDER survives. Two effects over two buffers would silently re-decide
   * that order by their declaration order here; one queue makes it structural.
   */
  useEffect(
    () =>
      drainEditorMessages((m) => {
        if (m.kind === 'open') {
          setState((s) => openTab(s, m.req))
          return
        }
        const restored = m.tabs
        setState((s) => {
          const next = restored.tabs.reduce(
            (acc, t) => openTab(acc, { kind: t.kind, name: t.name, mode: t.mode }, t.view),
            s
          )
          const active = next.tabs[restored.activeIndex]
          return active ? activateTab(next, active.id) : next
        })
      }),
    []
  )

  // Fire-and-forget on every structural change AND every cursor move; main debounces the write
  // (spec §4.2's policy, reused). `state` in the dependency array is deliberate — a shallower
  // signal would miss cursor movement, which is half of what restore is for.
  //
  // The `emptyTabs` guard is load-bearing, not an optimisation. This effect also runs on MOUNT,
  // when the window has no tabs yet and restore has not arrived — reporting `{ tabs: [] }` there
  // tells main to persist an empty set over the one it is in the middle of restoring. The
  // debounce happens to cover the race today (restore lands at `did-finish-load`, well inside
  // 1s), but a persisted tab set must not depend on winning a race. An empty set is still
  // reported normally once the user has closed their last tab, because `state` is no longer
  // reference-equal to `emptyTabs` by then.
  useEffect(() => {
    if (state === emptyTabs) return
    const report: PersistedTabs = {
      tabs: state.tabs.map((t) => ({ kind: t.kind, name: t.name, mode: t.mode, view: t.view })),
      activeIndex: state.tabs.findIndex((t) => t.id === state.activeId)
    }
    window.argus.editor.tabsChanged(report)
  }, [state])

  // One stable identity for all N tabs — a functional update means this never has to close over
  // the current state, so `AssetPane`'s dirty effect and its unmount cleanup do not re-fire on
  // every keystroke somewhere else in the window.
  const onDirtyChange = useCallback((id: string, d: boolean) => {
    setState((s) => setTabDirty(s, id, d))
  }, [])
  const onNameChange = useCallback((id: string, name: string) => {
    setState((s) => renameTab(s, id, name))
  }, [])
  // A create-mode tab stops being one the moment its first save lands. Both halves of finding 1
  // — the duplicate tab on a later Library *Edit*, and the template clobber after a restart —
  // are this one missing transition; see `markTabSaved` in tabs.ts, including why `req` stays
  // frozen while `Tab.mode` moves.
  const onSaved = useCallback((id: string, name: string) => {
    setState((s) => markTabSaved(s, id, name))
  }, [])
  const onViewStateChange = useCallback((id: string, view: TabViewState) => {
    setState((s) => setTabView(s, id, view))
  }, [])
  const onActivate = useCallback((id: string) => setState((s) => activateTab(s, id)), [])
  const onClose = useCallback((id: string) => setState((s) => closeTab(s, id)), [])

  /**
   * *Edit a copy* (spec §6.2). Takes `(id, kind, name)` rather than a whole `Tab` so `TabPane`
   * can bind it on the same primitives as the other tab callbacks — see the comment on
   * `handleEditCopy` there.
   *
   * The two flows are asymmetric on purpose: a skill FORK creates a new name, so it needs the
   * name-entry dialog and its inline collision retry (`forkSkill` throws on a taken name); a
   * reference CLAIM keeps the same name and only changes the tier, so a plain confirm suffices.
   * Both still finish through `replaceTab`, which re-derives `readOnly` for the new pane (see
   * tabs.ts).
   *
   * **Both flows report a rejected IPC.** The fork's goes to `ForkSkillDialog`, which is still on
   * screen and can offer another name; the claim has no dialog left by then, so it goes to the
   * app-wide `alert()` (lib/confirmStore) — the same convention `ObservabilitySettings` and
   * `connectorForm` use for an IPC that rejects out of an event handler. Nothing here may be left
   * as a bare unhandled rejection: this used to sit in a `catch`-less `void (async () => …)()`,
   * and a claim that main refused looked exactly like a button that did nothing.
   */
  const editCopy = useCallback(
    (id: string, kind: AuthoringKind, name: string): void => {
      if (kind === 'skill') {
        const tier = tierOf(kind, name)
        setForking({ id, name, tier: tier === 'bundled' ? 'bundled' : 'hivemind' })
        return
      }
      void (async () => {
        const ok = await confirm({
          title: `Make "${name}" yours?`,
          message:
            'It is restamped as your own reference and becomes shareable. Updates no longer track HiveMind.',
          confirmLabel: 'Claim'
        })
        if (!ok) return
        try {
          await window.argus.hivemind.claimReference(name)
        } catch (e) {
          await alert({
            title: `Could not make "${name}" yours.`,
            message: e instanceof Error ? e.message : String(e)
          })
          return
        }
        // Same name, new tier. Still a replaceTab: the fresh tab id re-resolves the asset, and
        // the tier map it reads may still be the pre-claim one — `readOnly` is reconfigured
        // through a Compartment when `refsync:changed` lands, so a stale read self-corrects
        // instead of stranding the pane read-only (see CodeSurface's `readOnly` prop).
        setState((s) => replaceTab(s, id, { kind: 'reference', name, mode: 'edit' }))
      })()
    },
    [tierOf]
  )

  useEffect(
    () =>
      window.argus.editor.onCloseRequested((info) => {
        void (async () => {
          if (dirtyRef.current === 0) {
            window.argus.editor.respondClose(true)
            return
          }
          // Spec §3.5: reports rather than warns, and deliberately does not claim a destruction
          // that no longer happens. Not `danger` for the same reason. `info.dirtyCount` comes
          // back from main, which is the count this window sent it.
          const n = Math.max(1, info.dirtyCount)
          const allow = await confirm({
            title: `${n} ${n === 1 ? 'tab has' : 'tabs have'} unsaved changes.`,
            message: "They'll be kept as drafts.",
            confirmLabel: 'Close'
          })
          window.argus.editor.respondClose(allow)
        })()
      }),
    []
  )

  return (
    <div className="flex h-screen flex-col bg-deep p-3 text-ink">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-r3 border border-hair bg-panel">
        <TabBar
          tabs={state.tabs}
          activeId={state.activeId}
          onActivate={onActivate}
          onClose={onClose}
        />
        {state.tabs.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-dim">
            Nothing open. Pick a skill or reference in the Library.
          </div>
        ) : (
          state.tabs.map((t) => {
            // Create mode has no tier to look up and must never be gated on one — a create-mode
            // tab is always editable, and this skips the lookup rather than trusting `undefined`
            // (unresolved) to happen to fail open the same way.
            //
            // `t.name`, not `t.req.name`: once `markTabSaved` flips a saved create-mode tab to
            // edit mode this lookup starts running, and `req.name` is the frozen name the tab was
            // OPENED with. Creating a skill in a tab minted as "theirs" and saving it as "mine"
            // would otherwise resolve the hivemind tier of "theirs" and lock the user out of the
            // file they just wrote. For every edit-mode tab the two are identical.
            const generated = isGeneratedAsset(t.kind, t.name)
            const tier = t.mode === 'create' ? undefined : tierOf(t.kind, t.name)
            const readOnly = t.mode !== 'create' && (generated || !isAssetEditable(t.kind, tier))
            const active = t.id === state.activeId
            return (
              <TabPane
                key={t.id}
                tab={t}
                active={active}
                readOnly={readOnly}
                tier={tier}
                generated={generated}
                onDirtyChange={onDirtyChange}
                onNameChange={onNameChange}
                onSaved={onSaved}
                onViewStateChange={onViewStateChange}
                onEditCopy={editCopy}
                onCommandState={onCommandState}
                registerPane={registerPane}
                // The split has to happen HERE, at the call site, not inside `TabPane`. `TabPane`
                // is `memo`-wrapped, and every tab's `.map` iteration used to pass this same
                // `commands` — rebuilt on every keystroke via the `useMemo` above — to EVERY
                // `TabPane`, active or not. `memo`'s shallow comparison saw a changed `commands`
                // identity on every one of them and re-rendered all N tabs on every keystroke
                // anywhere in the window, defeating the whole point of wrapping `TabPane` in
                // `memo` (see the file-level comment on it). Computing the split here means every
                // INACTIVE tab receives the same frozen `NO_COMMANDS` reference release over
                // release, so `memo` actually sees no change for it and skips the re-render.
                commands={active ? commands : NO_COMMANDS}
              />
            )
          })
        )}
      </div>
      {palette !== null && (
        <CommandPalette
          raw={palette}
          onRawChange={setPalette}
          commands={commands}
          assets={assetRows}
          onPickAsset={pickAsset}
          onDiscardDraft={discardDraftRow}
          onClose={() => setPalette(null)}
        />
      )}
      {forking && (
        <ForkSkillDialog
          sourceName={forking.name}
          tier={forking.tier}
          onCancel={() => setForking(null)}
          onConfirm={async (newName) => {
            // This is the fork flow's error handling — deliberately a rejection rather than a
            // catch. `ForkSkillDialog.submit` awaits this and renders what it throws in its own
            // `role="alert"`, staying open for another name, which is what makes a collision
            // recoverable instead of dumping the user back on a dead tab. Catching here (or
            // routing to `alert()` like the claim above) would take that retry away.
            const { name } = await window.argus.skills.fork(forking.name, newName)
            setState((s) => replaceTab(s, forking.id, { kind: 'skill', name, mode: 'edit' }))
            setForking(null)
          }}
        />
      )}
      <ConfirmHost />
    </div>
  )
}
