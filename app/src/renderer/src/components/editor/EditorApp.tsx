import { useCallback, useEffect, useRef, useState } from 'react'
import { AssetTab } from './AssetTab'
import { TabBar } from './TabBar'
import { ConfirmHost } from '../ConfirmHost'
import { confirm } from '../../lib/confirmStore'
import { drainOpenTabs } from './editorBootstrap'
import {
  activateTab,
  closeTab,
  dirtyCount,
  emptyTabs,
  openTab,
  renameTab,
  setTabDirty,
  setTabView,
  type Tab,
  type TabsState
} from './tabs'
import type { TabViewState } from '../../../../shared/editorIpc'

interface TabPaneProps {
  tab: Tab
  active: boolean
  onDirtyChange: (id: string, dirty: boolean) => void
  onNameChange: (id: string, name: string) => void
  onViewStateChange: (id: string, view: TabViewState) => void
}

/**
 * One tab's slot. Pulled out of `EditorApp`'s `.map` so each of `AssetTab`'s three callback props
 * gets an identity that is stable across `EditorApp` re-renders, not a fresh closure every time.
 *
 * `AssetPane`'s dirty-report effect depends on `[dirty, onDirtyChange]` (by design — it has to
 * see a prop-identity change to requery). A `.map`-inline `(d) => onDirtyChange(t.id, d)` is a new
 * function on every `EditorApp` render, so that effect would refire on *every* render regardless
 * of whether `dirty` actually changed; `setTabDirty` always returns a new `TabsState` (`tabs.ts`'s
 * `patch` maps unconditionally), so every refire triggers another `EditorApp` render — an
 * unbounded render loop that reproduces as an OOM the moment a second tab exists to feed it.
 * Binding `tab.id` inside this component via `useCallback` keeps the identity fixed for the life
 * of the tab, so the effect only re-fires when `dirty` itself flips.
 */
function TabPane({
  tab,
  active,
  onDirtyChange,
  onNameChange,
  onViewStateChange
}: TabPaneProps): React.JSX.Element {
  const handleDirtyChange = useCallback(
    (d: boolean) => onDirtyChange(tab.id, d),
    [tab.id, onDirtyChange]
  )
  const handleNameChange = useCallback(
    (n: string) => onNameChange(tab.id, n),
    [tab.id, onNameChange]
  )
  const handleViewStateChange = useCallback(
    (v: TabViewState) => onViewStateChange(tab.id, v),
    [tab.id, onViewStateChange]
  )

  return (
    // The whole class string swaps rather than toggling the `hidden` ATTRIBUTE: `[hidden]`
    // is a UA rule at effectively zero specificity and `.flex` beats it, so a
    // "hidden" tab would render on top of the active one. Tailwind's `hidden` utility is
    // `display: none`, which also takes the subtree out of the a11y tree — no
    // `aria-hidden`, which on a subtree containing the focused element would be a bug.
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <AssetTab
        // `tab.req`, NOT a request rebuilt from `tab.name`. The two differ exactly while a
        // create-mode tab is being renamed, and rebuilding would re-run AssetTab's resolve
        // effect on every keystroke in the name field — re-reading disk and re-resolving the
        // draft under a live buffer. See tabs.ts's note on `req`.
        req={tab.req}
        active={active}
        readOnly={false}
        initialViewState={tab.view}
        onDirtyChange={handleDirtyChange}
        onNameChange={handleNameChange}
        onViewStateChange={handleViewStateChange}
      />
    </div>
  )
}

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

  // Read across the async confirm in the close handler so the answer reflects the tab set now,
  // not when the subscription was created.
  const dirtyRef = useRef(dirty)
  useEffect(() => {
    dirtyRef.current = dirty
    window.argus.editor.setDirty(dirty)
  }, [dirty])

  // Drains the module-scope buffer (see editorBootstrap.ts). NOT a raw onOpenTab subscription:
  // main flushes its queued open-tab message on `did-finish-load`, which can precede React's
  // passive effects — subscribing here alone would re-open the dropped-first-message bug that
  // Increment 1 fixed on the main side.
  useEffect(() => drainOpenTabs((req) => setState((s) => openTab(s, req))), [])

  // One stable identity for all N tabs — a functional update means this never has to close over
  // the current state, so `AssetPane`'s dirty effect and its unmount cleanup do not re-fire on
  // every keystroke somewhere else in the window.
  const onDirtyChange = useCallback((id: string, d: boolean) => {
    setState((s) => setTabDirty(s, id, d))
  }, [])
  const onNameChange = useCallback((id: string, name: string) => {
    setState((s) => renameTab(s, id, name))
  }, [])
  const onViewStateChange = useCallback((id: string, view: TabViewState) => {
    setState((s) => setTabView(s, id, view))
  }, [])
  const onActivate = useCallback((id: string) => setState((s) => activateTab(s, id)), [])
  const onClose = useCallback((id: string) => setState((s) => closeTab(s, id)), [])

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
          state.tabs.map((t) => (
            <TabPane
              key={t.id}
              tab={t}
              active={t.id === state.activeId}
              onDirtyChange={onDirtyChange}
              onNameChange={onNameChange}
              onViewStateChange={onViewStateChange}
            />
          ))
        )}
      </div>
      <ConfirmHost />
    </div>
  )
}
