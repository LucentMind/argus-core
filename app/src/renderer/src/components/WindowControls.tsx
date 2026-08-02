import { useEffect, useState } from 'react'
import { isDarwin } from '../lib/platform'

/**
 * The window's own minimize / maximize / close, drawn by us (spec
 * 2026-08-01-header-window-controls-design.md §3.4).
 *
 * The main window is constructed with no native `titleBarOverlay` on win32/linux — an overlay
 * paints an opaque OS-owned rectangle that the ambient flow cannot read through — so on those
 * platforms these buttons are the only way to drive the window. On darwin the traffic lights are
 * the OS's and cannot be removed, so this renders nothing there.
 *
 * Full header height and flush into the corner, deliberately: the top-right pixel is a free
 * infinite-height target (Fitts's law), and the OS buttons have always owned it. `TopBar` drops
 * its right padding when this renders, for the same reason.
 *
 * Glyphs are inline SVG rather than lucide icons: at 10px the lucide set's 24px-tuned corner radii
 * and stroke joins render mushy, and the caption glyphs are geometric primitives that carry no
 * icon-set identity worth importing.
 *
 * ACCEPTED LOSS: Windows 11's snap-layouts flyout on maximize-hover. Electron exposes no way to
 * keep it for renderer-drawn buttons; keeping it would mean keeping the native overlay.
 */

const BTN =
  'argus-nodrag inline-flex h-full w-[46px] shrink-0 items-center justify-center text-dim transition-colors'
const HOVER = 'hover:bg-hair hover:text-ink'
const CLOSE_HOVER = 'hover:bg-danger hover:text-white'

function Glyph({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function WindowControls(): React.JSX.Element | null {
  const [maximized, setMaximized] = useState(false)

  // Hooks run unconditionally; the darwin bail-out is below them.
  useEffect(() => {
    let alive = true
    const api = window.argus?.window
    void api?.isMaximized().then((v) => {
      if (alive) setMaximized(v)
    })
    const off = api?.onMaximizedChanged((v) => setMaximized(v))
    return () => {
      alive = false
      off?.()
    }
  }, [])

  if (isDarwin()) return null

  const maxLabel = maximized ? 'Restore' : 'Maximize'
  return (
    // ONE group, not three loose children. A fragment here made each button a direct flex child
    // of the header, so the header's `gap-1.5` opened a 6px gutter between them — at which point
    // they read as three more toolbar icons continuing the gauge/settings/theme row rather than
    // as the window's caption cluster. A caption cluster is contiguous; the single gap now falls
    // before the group, and `ml-1` widens it a little to say "these belong to the window, not to
    // the app". `self-stretch` rather than the buttons' own `h-12`: with the dynamic theme off
    // the header carries `border-b`, so its content box is 47px and centring a 48px child in it
    // left every button half a pixel proud of the header.
    <div className="ml-1 flex shrink-0 self-stretch">
      <button
        data-testid="window-minimize"
        className={`${BTN} ${HOVER}`}
        aria-label="Minimize"
        title="Minimize"
        onClick={() => void window.argus?.window?.minimize()}
      >
        <Glyph>
          <path d="M0.5 5h9" />
        </Glyph>
      </button>
      <button
        data-testid="window-maximize"
        className={`${BTN} ${HOVER}`}
        aria-label={maxLabel}
        title={maxLabel}
        onClick={() => void window.argus?.window?.toggleMaximize()}
      >
        <Glyph>
          {maximized ? (
            <>
              {/* the sheet behind, clipped to an L so the two squares read as stacked */}
              <path d="M2.75 2.75V1.75a1 1 0 0 1 1-1h4.5a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1h-1" />
              <rect x="0.75" y="2.75" width="6.5" height="6.5" rx="1" />
            </>
          ) : (
            <rect x="0.75" y="0.75" width="8.5" height="8.5" rx="1" />
          )}
        </Glyph>
      </button>
      <button
        data-testid="window-close"
        className={`${BTN} ${CLOSE_HOVER}`}
        aria-label="Close"
        title="Close"
        onClick={() => void window.argus?.window?.close()}
      >
        <Glyph>
          <path d="M1 1l8 8M9 1l-8 8" />
        </Glyph>
      </button>
    </div>
  )
}
