import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { X, ExternalLink, PinOff, PanelTop, Search } from 'lucide-react'
import { MenuButton } from './ui'
import { panelsStore } from '../lib/panelsStore'
import { CHAT_TAB } from '../lib/panelsStore'
import { externalAppsStore } from '../lib/externalAppsStore'
import { panelKeyStr, type PanelDecl, type PanelInfo, type PanelKey } from '../../../shared/panels'
import type { ChatJumpTarget } from '../../../shared/types'
import { SessionSwitcher } from './SessionSwitcher'
import { SessionChips } from './SessionChips'

const keyOf = (p: PanelInfo): PanelKey => ({
  caseSlug: p.caseSlug,
  packId: p.packId,
  windowId: p.windowId
})

export function PanelTabStrip({
  slug,
  sessionId,
  activeTab,
  onSelect,
  activeSessionId,
  instanceId,
  onSwitchSession,
  onJumpToTurn,
  action,
  onOpenFind = () => {}
}: {
  slug: string
  sessionId: number | null
  activeTab: string
  onSelect: (tab: string) => void
  /** The chat this bar's Chat tab is a trigger for — separate from `sessionId` above (which
   *  is what a *newly opened panel* is scoped to). Null only in the brief window before the
   *  case's session list has resolved. */
  activeSessionId: number | null
  /** Provider instance running the active chat — cost reporting is per-provider. */
  instanceId: string | null
  onSwitchSession: (id: number) => void
  onJumpToTurn: (sessionId: number, target: ChatJumpTarget) => void
  /** Rendered in the launcher's place. Supplying this hides `New panel` — review mode
   *  passes `Run review` here because review does not offer panels. Panels already open
   *  are deliberately untouched: review cannot *create* one, but entering it must not
   *  discard state the user built. */
  action?: ReactNode
  /** Opens the in-transcript find overlay (ChatFind) — previously reachable only via
   *  Ctrl+F, with no visible affordance; this button surfaces it. */
  onOpenFind?: () => void
}): React.JSX.Element {
  const st = useSyncExternalStore(
    (cb) => panelsStore.subscribe(cb),
    () => panelsStore.get()
  )
  const ext = useSyncExternalStore(
    (cb) => externalAppsStore.subscribe(cb),
    () => externalAppsStore.get()
  )

  async function launch(d: PanelDecl): Promise<void> {
    if (d.kind === 'externalApp') {
      await window.argus.externalApps.open({
        caseSlug: slug,
        sessionId,
        packId: d.packId,
        windowId: d.windowId
      })
      return // external apps get a presence chip, not a tab
    }
    await window.argus.panels.open({
      caseSlug: slug,
      packId: d.packId,
      windowId: d.windowId,
      sessionId
    })
    onSelect(panelKeyStr({ caseSlug: slug, packId: d.packId, windowId: d.windowId }))
  }

  const launcherItems = st.decls.map((d) => ({
    label: d.title,
    onSelect: () => void launch(d)
  }))

  return (
    // This is now CaseWorkspace's centre chrome row — a sibling above the card, not a rule
    // inside one, so it carries no `border-b border-hair` (that would draw a stray line on the
    // ground plane) and no horizontal `px-2` (its first tab lands flush with the card's left
    // edge below, exactly as each rail's collapse toggle aligns with its cards' left edge).
    // `h-8`, matching both rails' chrome rows, is what puts all three columns' chrome on one y.
    <div className="flex h-8 shrink-0 items-center gap-1">
      {/* No role="tab" here: the strip container carries no role="tablist" and the sibling
          panel tabs below carry no role either, so a lone "tab" here would be an orphan —
          ARIA doesn't permit that, and "tab" is on the presentational-children list, meaning
          a conforming assistive tech may prune the SessionSwitcher trigger button living
          inside it (the one whose aria-label carries the chat title). Also no tabIndex/
          onKeyDown on this wrapper: a previous round added those to make the div itself a
          keyboard tab stop, but with no origin guard the keydown handler cancelled Enter/
          Space for every descendant control too (SessionSwitcher's trigger, the popup's
          buttons, the rename input, the "Search chats" input) — defaultPrevented on keydown
          suppresses both character insertion and the synthesized activation click in a real
          browser, so it silently broke typing a space into search/rename and broke Enter/
          Space on every button in the popup. Keyboard reachability comes from the real
          button that's already here: SessionSwitcher's trigger (or, with no session yet, the
          fallback button below) is a focusable <button>; Enter/Space activates it and the
          resulting click bubbles to this div's onClick, selecting the chat tab exactly as
          clicking anywhere else in the tab does. */}
      <div
        className={`flex min-w-32 shrink items-center border-b-2 ${
          activeTab === CHAT_TAB ? 'border-signal' : 'border-transparent'
        }`}
        onClick={() => onSelect(CHAT_TAB)}
      >
        {activeSessionId !== null ? (
          <SessionSwitcher
            slug={slug}
            sessionId={activeSessionId}
            onSwitch={onSwitchSession}
            onJumpToTurn={onJumpToTurn}
          />
        ) : (
          // Fallback for the brief (or, on a sessions.list failure, permanent) window before
          // activeSessionId resolves — "Chat" is what this tab read before Task 4's merge.
          // A real <button> (not a <span>): SessionSwitcher isn't mounted in this branch, so
          // there's no nested-button hazard, and this is the only way this state has a
          // keyboard-reachable tab stop at all.
          // No onClick here: the click bubbles to the wrapper div's onClick above, same as
          // SessionSwitcher's trigger button does in the other branch.
          <button
            type="button"
            className={`px-2 py-1.5 text-xs ${
              activeTab === CHAT_TAB ? 'text-ink' : 'text-dim'
            }`}
          >
            Chat
          </button>
        )}
      </div>
      {st.panels.map((p) => {
        const id = panelKeyStr(p)
        return (
          <div
            key={id}
            className={`group flex items-center gap-1 border-b-2 px-2 py-1.5 text-xs ${
              activeTab === id
                ? 'border-signal text-ink'
                : 'border-transparent text-dim hover:text-ink'
            }`}
          >
            <button className="max-w-40 truncate" onClick={() => onSelect(id)}>
              {p.title}
              {p.floated && <span className="ml-1 text-mute">(floated)</span>}
            </button>
            {p.floated ? (
              <button
                aria-label={`Dock ${p.title}`}
                title="Dock back"
                className="text-mute hover:text-ink"
                onClick={() => {
                  void window.argus.panels.dockBack(keyOf(p))
                  onSelect(id)
                }}
              >
                <PinOff size={12} />
              </button>
            ) : (
              <button
                aria-label={`Pop out ${p.title}`}
                title="Pop out"
                className="text-mute opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                onClick={() => void window.argus.panels.popOut(keyOf(p))}
              >
                <ExternalLink size={12} />
              </button>
            )}
            <button
              aria-label={`Close ${p.title}`}
              title="Close"
              className="text-mute opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
              onClick={() => {
                void window.argus.panels.close(keyOf(p))
                if (activeTab === id) onSelect(CHAT_TAB)
              }}
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
      {ext.apps.map((a) => {
        const k = { caseSlug: a.caseSlug, packId: a.packId, windowId: a.windowId }
        return (
          <div
            key={panelKeyStr(a)}
            className="flex items-center gap-1 rounded border border-hair px-2 py-1 text-xs text-dim"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${a.status === 'running' ? 'bg-signal' : 'bg-mute'}`}
            />
            <span className="max-w-32 truncate">{a.title}</span>
            <button
              aria-label={`Stop ${a.title}`}
              title={a.status === 'running' ? 'Stop' : 'Dismiss'}
              className="text-mute hover:text-danger"
              onClick={() => void window.argus.externalApps.stop(k)}
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
      <div className="ml-auto flex items-center gap-2">
        {activeSessionId !== null && (
          // Stays mounted across chat<->panel toggles and is hidden (not unmounted) on a
          // panel tab: SessionChips' mount effect calls agent.authStatus() and the uncached
          // agent.preflight() (which spawns a doctor subprocess per pathDir pack decl), so
          // remounting on every tab toggle re-ran both every time and visibly reverted the
          // chip to "checking…". The HTML `hidden` attribute, not a Tailwind `hidden` class —
          // jsdom applies no stylesheet, so a CSS-only hidden class would leave the element
          // reporting as visible to toBeVisible() while a real browser painted it away.
          <div hidden={activeTab !== CHAT_TAB}>
            <SessionChips slug={slug} sessionId={activeSessionId} instanceId={instanceId} />
          </div>
        )}
        {activeTab === CHAT_TAB && activeSessionId !== null && (
          <>
            <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-hair2" />
            <button
              type="button"
              aria-label="Find in transcript"
              title="Find in transcript (Ctrl+F)"
              className="rounded-r1 px-1.5 py-0.5 text-mute transition-colors hover:bg-hair hover:text-ink"
              onClick={onOpenFind}
            >
              <Search size={14} strokeWidth={1.5} />
            </button>
          </>
        )}
      </div>
      {action ||
        (launcherItems.length > 0 && (
          <MenuButton
            label={<PanelTop size={14} aria-hidden="true" />}
            aria-label="New panel"
            title="New panel"
            align="right"
            items={launcherItems}
            // Hide the docked panel's native view (which paints over DOM) while this
            // dropdown is open, else its items are unclickable and no second panel can
            // ever be opened.
            onOpenChange={(o) => panelsStore.setLauncherOpen(o)}
          />
        ))}
    </div>
  )
}
