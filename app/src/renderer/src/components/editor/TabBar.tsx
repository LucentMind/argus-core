import { useEffect, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { tabElementId, tabPanelElementId, type Tab } from './tabs'

export interface TabBarProps {
  tabs: Tab[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
}

/**
 * The tab strip (spec §6.1). Presentational: it knows the `Tab` shape and nothing else — no
 * document, no draft, no tier. Overflow scrolls horizontally, and the dropdown is how a tab that
 * has scrolled out of sight is reached.
 *
 * The accessible name carries kind, name and dirtiness, because that is the whole of what the
 * strip communicates and none of it may be colour-only: `notes.md` can exist as both a skill and
 * a reference, and spec §6.1's dot is information a screen reader needs too.
 */
export function TabBar({
  tabs,
  activeId,
  onActivate,
  onClose
}: TabBarProps): React.JSX.Element | null {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // Keyed by tab id so arrow/Home/End navigation can move DOM focus to a tab that is about to
  // become active (see `onTablistKeyDown`). A ref, not state — this component owns no state
  // beyond `menuOpen`.
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // Mirrors MenuButton's dismissal effect (ui.tsx): closes on Escape and on a click outside the
  // trigger/menu. TabBar doesn't reuse MenuButton itself — its trigger is a bare chevron-only
  // icon button with its own layout, and MenuButton's trigger always renders a label plus a
  // "▾" affordance, which would either duplicate the chevron or force a layout that isn't this
  // strip's. Mirroring the effect gets the same dismissal behaviour without disturbing the strip.
  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  if (tabs.length === 0) return null

  // Roving tabindex (WAI-ARIA tabs pattern), automatic activation: ArrowLeft/ArrowRight move
  // focus AND activate the adjacent tab (wrapping at the ends); Home/End jump to the first/last
  // tab. Automatic activation was the deliberate choice, not manual — it matches the existing
  // click-to-activate behaviour, and it means `tabIndex` can stay tied to `activeId` alone
  // (0 on the active tab, -1 on the rest) instead of needing a separate "focused but not
  // selected" bit of state that this presentational component otherwise has no reason to own.
  const onTablistKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const idx = tabs.findIndex((t) => t.id === activeId)
    if (idx === -1) return
    let nextIdx: number | null = null
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') nextIdx = 0
    else if (e.key === 'End') nextIdx = tabs.length - 1
    if (nextIdx === null) return
    e.preventDefault()
    const next = tabs[nextIdx]
    onActivate(next.id)
    // tabIndex on the newly-active tab only flips to 0 on the next render; focus it directly so
    // the roving-tabindex model works within this same keystroke.
    tabRefs.current[next.id]?.focus()
  }

  return (
    <div className="flex shrink-0 items-stretch border-b border-hair bg-hi">
      <div
        role="tablist"
        className="flex min-w-0 flex-1 overflow-x-auto"
        onKeyDown={onTablistKeyDown}
      >
        {tabs.map((t) => {
          const active = t.id === activeId
          return (
            <div
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el
              }}
              id={tabElementId(t.id)}
              role="tab"
              aria-controls={tabPanelElementId(t.id)}
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              // `(tab)` suffix, not just `${t.kind} · ${t.name}`: the active tab's own editor
              // surface carries that exact string as ITS accessible name too (AssetPane's
              // `ariaLabel={`${kind} · ${initialName}`}`), and both are on screen at once — this
              // strip is never the only thing rendered. Task 6 is the first place `TabBar` and
              // `AssetPane` ever mount together, and without this suffix `getByLabelText`/
              // `findByLabelText` for the surface resolves to whichever of the two exists first
              // (this div, always — it renders synchronously; the surface waits on `AssetTab`'s
              // async resolve), not a "sometimes" bug but a deterministic wrong-element match.
              // A suffix, not a prefix: `TabBar.test.tsx` anchors its kind/name regex at `^`.
              aria-label={`${t.kind} · ${t.name}${t.dirty ? ' · unsaved changes' : ''} (tab)`}
              onClick={() => onActivate(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onActivate(t.id)
                }
              }}
              className={`group flex shrink-0 cursor-pointer items-center gap-2 border-r border-hair px-3 py-1.5 text-xs ${
                active ? 'bg-panel text-ink' : 'text-dim hover:text-ink'
              }`}
            >
              <span className="max-w-[14rem] truncate font-mono">{t.name}</span>
              {t.dirty && <span aria-hidden="true" className="size-1.5 rounded-full bg-review" />}
              <button
                type="button"
                aria-label={`Close ${t.name}`}
                // A nested native <button> stays a tab stop regardless of its ancestor's
                // tabIndex, so without pinning this to the tab's own roving state, every close
                // button would be reachable via Tab even when its tab is not — incoherent, and
                // it starved keyboard users of ever reaching an inactive tab at all.
                tabIndex={active ? 0 : -1}
                // Without this the same click also reaches the tab's onClick and activates the
                // tab that is being removed.
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(t.id)
                }}
                className="text-faint opacity-0 hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>
      {tabs.length > 1 && (
        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            aria-label="All tabs"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            className="flex h-full items-center px-2 text-faint hover:text-ink"
          >
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full z-10 max-h-80 w-64 overflow-y-auto rounded-r2 border border-hair bg-panel py-1 shadow-lg"
            >
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    onActivate(t.id)
                  }}
                  className={`block w-full truncate px-3 py-1.5 text-left font-mono text-xs hover:bg-hi ${
                    t.id === activeId ? 'text-ink' : 'text-dim'
                  }`}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
