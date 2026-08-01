import { TITLEBAR_HEIGHTS, type TitleBarKind } from '../../../shared/titleBarHeights'

/**
 * The bare drag strip both frameless windows carry above their real content (spec
 * 2026-08-01-frameless-chrome-increment-2). It paints nothing but the OS min/max/close buttons —
 * `argus-titlebar-inset` keeps `label` (when given) out from under them, and `argus-drag` is what
 * makes the strip draggable in the first place.
 *
 * Height comes from the shared `TITLEBAR_HEIGHTS` constant via an inline style, not a Tailwind
 * `h-*` class, so the renderer↔main coupling to the native overlay height is structural rather
 * than a comment that can drift out of step (see titleBarHeights.ts).
 */
export function TitleBarStrip({
  kind,
  label
}: {
  kind: TitleBarKind
  label?: string
}): React.JSX.Element {
  return (
    <div
      className="argus-drag argus-titlebar-inset flex shrink-0 items-center bg-deep text-xs text-dim"
      style={{ height: TITLEBAR_HEIGHTS[kind] }}
    >
      {label}
    </div>
  )
}
