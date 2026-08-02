import { useSyncExternalStore, type ReactNode } from 'react'
import { uiStore } from '../lib/uiStore'
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
 *
 * The anchors are PROPS, not state owned here: in Settings the light source is the page title and
 * the cutoff is the header's bottom edge, and both live in `TopBar` — a sibling of this scope, not
 * a descendant (spec 2026-08-01-header-window-controls-design.md §4.3). `App` owns the state and
 * renders `AmbientAnchorContext.Provider` around both.
 */
export function DynamicScope({
  variant,
  light,
  cutoff,
  children
}: {
  variant: DynamicVariant
  light: HTMLElement | null
  cutoff: HTMLElement | null
  children: ReactNode
}): React.JSX.Element {
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const on = ui.dynamicTheme
  // Home keeps the fragment-when-off shape: it ships, it is verified, and the
  // classic home DOM must stay byte-identical.
  if (variant === 'home' && !on) return <>{children}</>

  // case/settings ALWAYS render the wrapper. The fragment↔wrapper swap remounts
  // the whole subtree, and the toggle lives in Settings — so with a settings
  // variant it would remount the page it is on, discarding scroll position and
  // any unsaved draft in an open memory or skill editor.
  // Home is a column like the others now that it pins its masthead and scrolls only the grid
  // region below it — it has to hand a bounded height down, not grow past the viewport.
  const layout = 'relative flex min-h-0 flex-1 flex-col'
  return (
    <div
      className={`${on ? `dyn dyn-${variant} bg-void ` : ''}${layout}`}
      data-testid={`dynamic-${variant}`}
    >
      {/* Every variant paints its own canvas, the case included. The canvas is `position: fixed`
          at the WINDOW's top edge — not at this wrapper's — and `anchorRect` measures anchors
          against the viewport, so one canvas per view lights the chrome and the view together.
          That is what makes a second canvas mounted behind the bar unnecessary: there is no
          lower aurora to avoid, because this one already starts above the header. */}
      {on && <AmbientCanvas light={light} cutoff={cutoff} theme={ui.theme} band={BANDS[variant]} />}
      {on && variant === 'home' && <div className="dyn-grain" aria-hidden="true" />}
      <div className="relative z-[1] flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  )
}
