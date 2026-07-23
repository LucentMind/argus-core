import { useSyncExternalStore } from 'react'
import { Sun, Moon, Settings, Gauge, Home } from 'lucide-react'
import { uiStore } from '../lib/uiStore'

const ACTION_BTN =
  'inline-flex h-10 w-10 items-center justify-center rounded-r2 text-dim transition-colors hover:bg-hair hover:text-ink'

export function TopBar({
  activeSlug,
  onHome,
  onSelect,
  onSettings,
  onObservability
}: {
  activeSlug: string | null
  onHome: () => void
  onSelect: (slug: string) => void
  onSettings: () => void
  onObservability?: () => void
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
    <header className="flex h-16 items-center gap-1.5 border-b border-hair bg-deep px-3">
      <button className={ACTION_BTN} onClick={onHome} aria-label="All cases" title="All cases">
        <Home size={21} strokeWidth={1.5} />
      </button>
      <div className="mx-1 h-6 w-px bg-hair" />
      <nav
        aria-label="Recent cases"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {ui.recentTabs.map((slug, i) => {
          const active = slug === activeSlug
          return (
            <span
              key={slug}
              className={`group relative flex shrink-0 items-center rounded-r2 border text-sm transition-colors ${
                active
                  ? 'border-hair bg-hi text-ink'
                  : 'border-transparent text-dim hover:bg-hair hover:text-ink'
              }`}
            >
              {i > 0 && (
                <span
                  data-tab-separator
                  aria-hidden="true"
                  className="pointer-events-none absolute -left-0.5 h-4 w-px bg-hair"
                />
              )}
              <button className="py-1.5 pl-3 font-mono" onClick={() => onSelect(slug)}>
                {slug}
              </button>
              <button
                aria-label={`Close ${slug}`}
                className="px-2 py-1.5 text-base leading-none text-mute opacity-0 transition-[color,opacity] hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                onClick={() => close(slug)}
              >
                ×
              </button>
            </span>
          )
        })}
      </nav>
      {onObservability && (
        <button
          className={ACTION_BTN}
          aria-label="Observability"
          title="Observability"
          onClick={onObservability}
        >
          <Gauge size={21} strokeWidth={1.5} />
        </button>
      )}
      <button className={ACTION_BTN} aria-label="Settings" title="Settings" onClick={onSettings}>
        <Settings size={21} strokeWidth={1.5} />
      </button>
      <button
        className={ACTION_BTN}
        aria-label={ui.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        title={ui.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        onClick={() => uiStore.toggleTheme()}
      >
        {ui.theme === 'dark' ? (
          <Sun size={21} strokeWidth={1.5} />
        ) : (
          <Moon size={21} strokeWidth={1.5} />
        )}
      </button>
    </header>
  )
}
