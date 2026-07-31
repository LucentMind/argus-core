import { useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import type { Tab } from './tabs'

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
  if (tabs.length === 0) return null

  return (
    <div className="flex shrink-0 items-stretch border-b border-hair bg-hi">
      <div role="tablist" className="flex min-w-0 flex-1 overflow-x-auto">
        {tabs.map((t) => {
          const active = t.id === activeId
          return (
            <div
              key={t.id}
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              aria-label={`${t.kind} · ${t.name}${t.dirty ? ' · unsaved changes' : ''}`}
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
        <div className="relative shrink-0">
          <button
            type="button"
            aria-label="All tabs"
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
