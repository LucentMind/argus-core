import { useCallback, useEffect, useRef, useState } from 'react'
import {
  GAUGE_TUNING,
  gaugeRenderer,
  parseToneColor,
  type GaugeRenderer
} from '../lib/contextGaugeGL'

/** Phase the ridge is frozen at when motion is off. Picked off the edge study — a phase where
 *  the crest leans rather than sitting near-straight, so a still frame still reads as a wave. */
const FROZEN_PHASE = 3.7

const REDUCED = '(prefers-reduced-motion: reduce)'

/**
 * The fill level inside the session-status pill.
 *
 * Two renderings, one reading:
 *
 *  - **classic** paints the flat CSS gradient (`.ctx-gauge`) — a clean, straight, unmoving edge.
 *    No canvas, no GPU, nothing to tear down.
 *  - **dynamic** paints a WebGL ridge whose crest wanders around the percentage (see
 *    `contextGaugeGL.ts`). Under `prefers-reduced-motion` it draws a still frame per reading and
 *    schedules nothing — the shape survives, the drift does not, which is the same trade the
 *    rest of the app's motion makes.
 *
 * The dynamic branch falls back to the classic one whenever WebGL2 is unavailable, which
 * includes every jsdom test that does not inject a renderer.
 */
export function ContextGauge({
  pct,
  dynamic,
  toneKey,
  light,
  renderer = gaugeRenderer
}: {
  /** 0-100, already clamped by the caller. */
  pct: number
  dynamic: boolean
  /**
   * Which status tone the pill is wearing. NOT used to pick a colour — the colour is still read
   * off `currentColor`, so there is one palette. This exists purely as a repaint signal: with
   * motion off there is no loop to notice that a failed session just went green, and the canvas
   * would sit there red under a green pill. That is exactly what shipped and had to be seen
   * live to be found.
   */
  toneKey: string
  /** Same story: the light branch is a different shader path, and a theme switch must repaint. */
  light: boolean
  /** Injected in tests; production always uses the shared single-context renderer. */
  renderer?: GaugeRenderer
}): React.JSX.Element {
  const wave = dynamic && renderer.available()
  const ref = useRef<HTMLCanvasElement | null>(null)

  // The drift loop reads the reading through a ref, never a dependency. A turn emits
  // `context.usage` several times, and a `pct` in that effect's deps would tear the loop down
  // and restart its clock on every one of them — the ridge would snap back to its frozen phase
  // mid-drift. Synced in an effect rather than during render (refs are not render state), and
  // declared FIRST so the still-frame effect below already sees the new value.
  const pctRef = useRef(pct)
  useEffect(() => {
    pctRef.current = pct
  }, [pct])

  const [reduced, setReduced] = useState(() => window.matchMedia?.(REDUCED)?.matches ?? false)
  useEffect(() => {
    const mq = window.matchMedia?.(REDUCED)
    if (!mq?.addEventListener) return
    const onChange = (): void => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const paint = useCallback(
    (t: number): void => {
      const cv = ref.current
      if (!cv) return
      // Size follows the element, not a constant: a canvas whose buffer disagrees with its
      // layout box blits at the wrong scale rather than clipping, which is the kind of bug that
      // only shows up on a HiDPI display.
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = cv.clientWidth || 94
      const h = cv.clientHeight || 19
      const bw = Math.round(w * dpr)
      const bh = Math.round(h * dpr)
      if (cv.width !== bw) cv.width = bw
      if (cv.height !== bh) cv.height = bh

      // Same source of truth as the CSS rendering: whatever tone the pill has set on itself.
      // Null means a colour this cannot read — skip the frame rather than paint a green ridge
      // on a failed session.
      const tone = parseToneColor(getComputedStyle(cv).color)
      if (!tone) return
      renderer.render(cv, { w, h, t, fill: pctRef.current / 100, light, tone, ...GAUGE_TUNING })
    },
    [renderer, light]
  )

  // Still frame. Every input that changes what should be on screen is a dependency here, because
  // with motion off this effect is the ONLY thing that will ever redraw: the reading, the status
  // tone, and the theme.
  useEffect(() => {
    if (wave && reduced) paint(FROZEN_PHASE)
  }, [wave, reduced, pct, toneKey, light, paint])

  // Drift.
  useEffect(() => {
    if (!wave || reduced) return
    let raf = 0
    let start: number | null = null
    const frame = (now: number): void => {
      if (start === null) start = now
      paint(FROZEN_PHASE + (now - start) / 1000)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [wave, reduced, paint])

  if (wave) {
    return (
      <canvas
        aria-hidden="true"
        data-testid="context-gauge"
        data-mode="wave"
        ref={ref}
        // `h-full w-full` is LOAD-BEARING, not belt-and-braces. A canvas is a replaced element:
        // with `width: auto` it takes its INTRINSIC 300x150 and the `right`/`bottom` offsets are
        // dropped, so `inset-0` alone leaves a 300x150 canvas pinned at the pill's top-left and
        // clipped to 94x19 by overflow. The shader then renders a 300px-wide gauge of which you
        // see the leftmost third — every reading lands at roughly a third of where it belongs.
        // Verified in Chromium: `inset-0` alone measures 300x150, `inset-0 h-full w-full`
        // measures 108x18. A sibling <span> with the same classes measures correctly either
        // way, which is exactly why swapping the span for a canvas broke it silently.
        //
        // Full width, NOT width:pct — the filament blooms past its own crest, and a
        // percentage-width element would shear that bloom off at exactly the interesting edge.
        // The percentage is painted inside the shader instead.
        className="pointer-events-none absolute inset-0 h-full w-full"
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      data-testid="context-gauge"
      data-mode="flat"
      className="ctx-gauge pointer-events-none absolute inset-y-0 left-0"
      style={{ width: `${pct}%` }}
    />
  )
}
