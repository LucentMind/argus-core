import { useSyncExternalStore } from 'react'
import { uiStore } from '../lib/uiStore'
import { IconBtn } from './ui'

const ICON = {
  size: 14,
  common: {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round'
  }
} as const

function TermIcon(): React.JSX.Element {
  return (
    <svg width={ICON.size} height={ICON.size} viewBox="0 0 24 24" {...ICON.common}>
      <path d="m4 7 4 4-4 4M10 15h10" />
      <rect x="2" y="3" width="20" height="18" rx="2" />
    </svg>
  )
}

function TermOffIcon(): React.JSX.Element {
  return (
    <svg width={ICON.size} height={ICON.size} viewBox="0 0 24 24" {...ICON.common}>
      <path d="m4 7 4 4-4 4M10 15h10" />
      <rect x="2" y="3" width="20" height="18" rx="2" />
      <path d="M2 2l20 20" />
    </svg>
  )
}

function SunIcon(): React.JSX.Element {
  return (
    <svg width={ICON.size} height={ICON.size} viewBox="0 0 24 24" {...ICON.common}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  )
}

function MoonIcon(): React.JSX.Element {
  return (
    <svg width={ICON.size} height={ICON.size} viewBox="0 0 24 24" {...ICON.common}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  )
}

export function TopBar({
  activeSlug,
  onHome,
  onSelect
}: {
  activeSlug: string | null
  onHome: () => void
  onSelect: (slug: string) => void
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
      <IconBtn
        aria-label={ui.showToolCalls ? 'Hide tool calls' : 'Show tool calls'}
        title={ui.showToolCalls ? 'Hide tool calls' : 'Show tool calls'}
        onClick={() => uiStore.toggleToolCalls()}
      >
        {ui.showToolCalls ? <TermIcon /> : <TermOffIcon />}
      </IconBtn>
      <IconBtn
        aria-label={ui.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        title={ui.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        onClick={() => uiStore.toggleTheme()}
      >
        {ui.theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </IconBtn>
    </header>
  )
}
