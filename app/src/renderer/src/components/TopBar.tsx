import { useSyncExternalStore } from 'react'
import { Sun, Moon, Plus, Settings } from 'lucide-react'
import { uiStore } from '../lib/uiStore'
import { IconBtn } from './ui'

export function TopBar({
  activeSlug,
  onHome,
  onSelect,
  onSettings,
  onNewCase
}: {
  activeSlug: string | null
  onHome: () => void
  onSelect: (slug: string) => void
  onSettings: () => void
  onNewCase: () => void
}): React.JSX.Element {
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )

  function close(slug: string): void {
    uiStore.closeTab(slug)
    if (slug === activeSlug) onHome()
  }

  return (
    <header className="flex h-11 items-center gap-1 border-b border-hair bg-deep px-2">
      <button
        className="flex items-center gap-2 rounded-r2 px-2 py-1 transition-colors hover:bg-hair"
        onClick={onHome}
        title="All cases"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-defect shadow-[0_0_12px_currentColor] text-defect" />
        <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.1em] text-ink">
          Argus
        </span>
      </button>
      <div className="mx-1 h-4 w-px bg-hair" />
      <nav
        aria-label="Recent cases"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {ui.recentTabs.map((slug) => {
          const active = slug === activeSlug
          return (
            <span
              key={slug}
              className={`group flex shrink-0 items-center rounded-r2 border text-xs transition-colors ${
                active
                  ? 'border-hair bg-hi text-ink'
                  : 'border-transparent text-dim hover:bg-hair hover:text-ink'
              }`}
            >
              <button className="py-1 pl-2.5 font-mono" onClick={() => onSelect(slug)}>
                {slug}
              </button>
              <button
                aria-label={`Close ${slug}`}
                className="px-1.5 py-1 text-mute transition-colors hover:text-danger"
                onClick={() => close(slug)}
              >
                ×
              </button>
            </span>
          )
        })}
      </nav>
      <IconBtn aria-label="New case" title="New case" onClick={onNewCase}>
        <Plus size={14} strokeWidth={1.5} />
      </IconBtn>
      <IconBtn aria-label="Settings" title="Settings" onClick={onSettings}>
        <Settings size={14} strokeWidth={1.5} />
      </IconBtn>
      <IconBtn
        aria-label={ui.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        title={ui.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        onClick={() => uiStore.toggleTheme()}
      >
        {ui.theme === 'dark' ? (
          <Sun size={14} strokeWidth={1.5} />
        ) : (
          <Moon size={14} strokeWidth={1.5} />
        )}
      </IconBtn>
    </header>
  )
}
