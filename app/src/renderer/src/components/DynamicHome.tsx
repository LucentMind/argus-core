import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { uiStore } from '../lib/uiStore'
import { AmbientAnchorContext, type AmbientAnchors } from '../lib/ambientAnchors'
import { AmbientCanvas } from './AmbientCanvas'

/**
 * Scope wrapper for the dynamic theme (spec 2026-07-31-dynamic-theme-design.md).
 * Off: renders a bare fragment — the DOM is exactly the classic home view.
 * On: stamps `.dynamic-home` (theme-dynamic.css re-declares the raw theme vars
 * under it, restyling every Tailwind utility inside and nothing outside),
 * mounts the ambient canvas + grain, and provides anchor-ref plumbing so
 * CaseDashboard can hand the wordmark/filter-row elements to the canvas.
 *
 * Toggling remounts the children (fragment vs wrapper) — accepted: the switch
 * lives in Settings, so the dashboard isn't holding transient state when it flips.
 *
 * The wrapper paints its own bg-void ground: App.tsx's bg-void sits OUTSIDE
 * this scope, so it resolves the classic tokens, not the scoped ones — without
 * a scoped bg-void here the canvas bottom edge would show a classic/dynamic
 * seam.
 */
export function DynamicHome({ children }: { children: ReactNode }): React.JSX.Element {
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const [hero, setHero] = useState<HTMLElement | null>(null)
  const [filters, setFilters] = useState<HTMLElement | null>(null)
  const anchors = useMemo<AmbientAnchors>(() => ({ setHero, setFilters }), [])
  if (!ui.dynamicTheme) return <>{children}</>
  return (
    <div className="dynamic-home relative min-h-full bg-void" data-testid="dynamic-home">
      <AmbientCanvas hero={hero} filters={filters} theme={ui.theme} />
      <div className="dyn-grain" aria-hidden="true" />
      <AmbientAnchorContext.Provider value={anchors}>
        <div className="relative z-[1]">{children}</div>
      </AmbientAnchorContext.Provider>
    </div>
  )
}
