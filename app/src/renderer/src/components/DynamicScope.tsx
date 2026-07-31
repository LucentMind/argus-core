import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { uiStore } from '../lib/uiStore'
import { AmbientAnchorContext, type AmbientAnchors } from '../lib/ambientAnchors'
import { AmbientCanvas } from './AmbientCanvas'
import { BANDS, type DynamicVariant } from '../lib/ambientBands'

export type { DynamicVariant }

/**
 * Scope wrapper for the dynamic theme (specs 2026-07-31-dynamic-theme-design.md
 * and -case-settings-design.md).
 *
 * `.dyn` carries the token block — theme.css maps every Tailwind colour through
 * raw vars (@theme inline), so re-declaring the raw vars under this class
 * restyles every utility inside the scope and nothing outside it. The
 * `.dyn-<variant>` class carries that view's own rules.
 *
 * Off: home renders a bare fragment — the DOM is exactly the classic home view.
 *
 * The wrapper paints its own bg-void ground: App.tsx's bg-void sits OUTSIDE
 * this scope, so it resolves the classic tokens, not the scoped ones — without
 * a scoped bg-void here the canvas bottom edge would show a seam.
 */
export function DynamicScope({
  variant,
  children
}: {
  variant: DynamicVariant
  children: ReactNode
}): React.JSX.Element {
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const [light, setLight] = useState<HTMLElement | null>(null)
  const [cutoff, setCutoff] = useState<HTMLElement | null>(null)
  const anchors = useMemo<AmbientAnchors>(() => ({ setLight, setCutoff }), [])
  const on = ui.dynamicTheme
  // Home keeps the fragment-when-off shape: it ships, it is verified, and the
  // classic home DOM must stay byte-identical.
  if (variant === 'home' && !on) return <>{children}</>

  // case/settings ALWAYS render the wrapper. The fragment↔wrapper swap remounts
  // the whole subtree, and the toggle lives in Settings — so with a settings
  // variant it would remount the page it is on, discarding scroll position and
  // any unsaved draft in an open memory or skill editor.
  const layout =
    variant === 'home' ? 'relative min-h-full' : 'relative flex min-h-0 flex-1 flex-col'
  return (
    <div
      className={`${on ? `dyn dyn-${variant} bg-void ` : ''}${layout}`}
      data-testid={`dynamic-${variant}`}
    >
      {on && <AmbientCanvas light={light} cutoff={cutoff} theme={ui.theme} band={BANDS[variant]} />}
      {on && variant === 'home' && <div className="dyn-grain" aria-hidden="true" />}
      <AmbientAnchorContext.Provider value={anchors}>
        {variant === 'home' ? (
          <div className="relative z-[1]">{children}</div>
        ) : (
          <div className="relative z-[1] flex min-h-0 flex-1 flex-col">{children}</div>
        )}
      </AmbientAnchorContext.Provider>
    </div>
  )
}
