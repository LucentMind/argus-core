import { TITLEBAR_HEIGHTS } from '../../../shared/titleBarHeights'

/**
 * The drag strip the EDITOR window carries above its real content (spec
 * 2026-08-01-frameless-chrome-increment-2). The main window no longer has one: its window
 * controls moved into `TopBar` (spec 2026-08-01-header-window-controls-design.md §3), so this
 * component now has exactly one caller and renders at exactly one height — there is no `kind`
 * prop to pick a variant with any more. (`TITLEBAR_HEIGHTS` itself still carries a `main` entry:
 * the main process reads it to size the darwin `titleBarOverlay` that centres the header's
 * caption buttons — see `shared/titleBarHeights.ts` — but nothing in the renderer needs it.)
 * `argus-titlebar-inset` keeps whatever it holds out from under the OS min/max/close buttons, and
 * `argus-drag` is what makes the strip draggable in the first place.
 *
 * The editor window fills it with its whole chrome — the tab strip plus the active pane's
 * actions — which is why this takes `children` rather than the `label` string it started with.
 * Anything interactive placed in here MUST carry `argus-nodrag` (or sit inside something that
 * does), or the OS drag handler swallows its clicks and, for a scrollable strip of tabs, its
 * scroll gestures too.
 *
 * Height comes from the shared `TITLEBAR_HEIGHTS` constant via an inline style, not a Tailwind
 * `h-*` class, so the renderer↔main coupling to the native overlay height is structural rather
 * than a comment that can drift out of step (see titleBarHeights.ts).
 */
export function TitleBarStrip({
  flush,
  children
}: {
  /**
   * Opts the strip's left edge out of the 12px design gutter (`argus-titlebar-inset--flush` in
   * main.css) so its leading child lines up with content below that starts at the window edge —
   * the editor window's first tab. It does NOT zero the inset outright: on macOS the darwin floor
   * still has to win so tabs don't land under the traffic lights, which is why this is a modifier
   * class rather than a `padding-left: 0` override (see main.css for how that's guaranteed).
   */
  flush?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={`argus-drag argus-titlebar-inset flex shrink-0 items-center bg-deep text-xs text-dim${
        flush ? ' argus-titlebar-inset--flush' : ''
      }`}
      style={{ height: TITLEBAR_HEIGHTS.editor }}
    >
      {children}
    </div>
  )
}
