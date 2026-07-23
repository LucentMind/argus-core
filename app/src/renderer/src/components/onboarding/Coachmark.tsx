import { useEffect, useState } from 'react'

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

function readRect(anchor: string): Rect | null {
  const el = document.querySelector(`[data-onboarding-anchor="${anchor}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

// A step transition can flip the app to a new view (e.g. settings) via an
// effect in the parent, so the anchored DOM node may mount a frame or two
// after Coachmark's own effect runs. Retry across a bounded number of
// animation frames before giving up and falling back to the centered callout.
const MAX_RESOLVE_ATTEMPTS = 30

export function Coachmark({
  anchor,
  children
}: {
  anchor: string
  children: React.ReactNode
}): React.JSX.Element {
  const [rect, setRect] = useState<Rect | null>(() => readRect(anchor))

  useEffect(() => {
    let cancelled = false
    let frameId: number | null = null
    let attempts = 0

    const update = (): void => setRect(readRect(anchor))

    const tryResolve = (): void => {
      const found = readRect(anchor)
      if (found) {
        if (!cancelled) setRect(found)
        return
      }
      attempts += 1
      if (attempts >= MAX_RESOLVE_ATTEMPTS) {
        if (!cancelled) setRect(null)
        return
      }
      frameId = requestAnimationFrame(tryResolve)
    }

    tryResolve()

    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      cancelled = true
      if (frameId !== null) cancelAnimationFrame(frameId)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor])

  if (!rect) {
    // fallback: centered callout, no ring — the tour never dead-ends
    return (
      <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center">
        <div className="pointer-events-auto max-w-sm">{children}</div>
      </div>
    )
  }

  // Prefer the callout below the anchor, but if the anchor is docked near the
  // bottom of the viewport (e.g. the chat composer) there isn't room — placing
  // it below would push the panel, and its Exit control, off-screen. In that
  // case dock it above the anchor via `bottom` so it grows upward and stays
  // visible regardless of the panel's own height.
  //
  // When docking above such a wide bottom anchor we also RIGHT-align to the
  // anchor's right edge instead of left. The composer's pending-approval card
  // renders just above it with Approve/Deny at its bottom-LEFT; a left-aligned
  // callout landed straight on those buttons (the "covering the approval"
  // bug). Right-aligning tucks the panel into the emptier right side, leaving
  // the action buttons reachable.
  const GAP = 8
  const spaceBelow = window.innerHeight - (rect.top + rect.height)
  const rightInset = Math.max(GAP, window.innerWidth - (rect.left + rect.width))
  const calloutStyle: React.CSSProperties =
    spaceBelow >= 200
      ? { top: rect.top + rect.height + GAP, left: rect.left }
      : { bottom: window.innerHeight - rect.top + GAP, right: rightInset }

  return (
    <div className="pointer-events-none fixed inset-0 z-[60]">
      <div
        data-testid="coachmark-ring"
        className="absolute rounded-r2 ring-2 ring-signal ring-offset-2 ring-offset-void"
        style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
      />
      <div className="pointer-events-auto absolute max-w-sm" style={calloutStyle}>
        {children}
      </div>
    </div>
  )
}
