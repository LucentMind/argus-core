import { TITLEBAR_HEIGHTS, type TitleBarKind } from '../../../shared/titleBarHeights'

/**
 * The drag strip both frameless windows carry above their real content (spec
 * 2026-08-01-frameless-chrome-increment-2). `argus-titlebar-inset` keeps whatever it holds out
 * from under the OS min/max/close buttons, and `argus-drag` is what makes the strip draggable in
 * the first place.
 *
 * The main window passes nothing and the strip stays bare. The editor window fills it with its
 * whole chrome — the tab strip plus the active pane's actions — which is why this takes
 * `children` rather than the `label` string it started with. Anything interactive placed in here
 * MUST carry `argus-nodrag` (or sit inside something that does), or the OS drag handler swallows
 * its clicks and, for a scrollable strip of tabs, its scroll gestures too.
 *
 * Height comes from the shared `TITLEBAR_HEIGHTS` constant via an inline style, not a Tailwind
 * `h-*` class, so the renderer↔main coupling to the native overlay height is structural rather
 * than a comment that can drift out of step (see titleBarHeights.ts).
 */
export function TitleBarStrip({
  kind,
  flush,
  children
}: {
  kind: TitleBarKind
  /**
   * Opts the strip's left edge out of the 12px design gutter (`argus-titlebar-inset--flush` in
   * main.css) so its leading child lines up with content below that starts at the window edge —
   * the editor window's first tab. It does NOT zero the inset outright: on macOS the darwin floor
   * still has to win so tabs don't land under the traffic lights, which is why this is a modifier
   * class rather than a `padding-left: 0` override (see main.css for how that's guaranteed). The
   * main window's bare strip never sets this — its right edge, and its lack of left-aligned
   * content, are unaffected.
   */
  flush?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={`argus-drag argus-titlebar-inset flex shrink-0 items-center bg-deep text-xs text-dim${
        flush ? ' argus-titlebar-inset--flush' : ''
      }`}
      style={{ height: TITLEBAR_HEIGHTS[kind] }}
    >
      {children}
    </div>
  )
}
