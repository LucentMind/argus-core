/** Chromium refuses to lay out a box taller than ~33.5M DEVICE pixels (Blink's
 *  LayoutUnit is an int32 of 1/64ths). Past that a virtual list's spacer sized
 *  `totalRows * rowHeight` silently stops growing — no error, no warning — and
 *  every row beyond it becomes unreachable by scrolling. The ceiling is counted
 *  in device px, so display scaling shrinks it: a 200MB logcat at 220% scaling
 *  dead-ended near line 762,600, and the same file cuts off at a different line
 *  on a 100% monitor.
 *
 *  Measure the real ceiling rather than hard-coding one — it moves with
 *  devicePixelRatio and differs between engines. Cached per DPR; the value only
 *  changes when the window moves to a differently-scaled display, which
 *  re-renders anyway. */

/** Blink's ceiling at devicePixelRatio 1, used only if measurement fails. */
const BLINK_MAX_LAYOUT_PX = 33_554_428
/** Headroom against subpixel rounding between the measured and used heights. */
const SAFETY_PX = 1024

let cache: { dpr: number; px: number } | null = null
let override: number | null = null

/** Test seam: jsdom has no layout engine, so the clamp cannot be measured
 *  there. Pass null to restore live measurement. */
export function __setMaxSpacerPxForTests(px: number | null): void {
  override = px
  cache = null
}

export function maxSpacerPx(): number {
  if (override !== null) return override
  const dpr = window.devicePixelRatio || 1
  if (cache && cache.dpr === dpr) return cache.px
  // Measure the laid-out height of a deliberately over-tall box. Read the box's
  // OWN rect, not an overflow container's scrollHeight: at narrow widths the
  // scrollbar does not fit and Chromium reports nonsense (85px for a 1px-wide
  // box), which would collapse the list to a sliver. getBoundingClientRect
  // reports the clamped height directly and ignores scrollbars entirely.
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:absolute;visibility:hidden;top:-9999px;left:-9999px;width:1px;height:1000000000px'
  document.body.appendChild(probe)
  const measured = probe.getBoundingClientRect().height
  probe.remove()
  // jsdom has no layout engine and reports 0 — derive the ceiling from the
  // known Blink limit instead. Never fall back to a fixed number: the ceiling
  // is counted in device px, so at 150% scaling it is only ~22.4M CSS px and a
  // hard-coded 30M would sail straight past it and reinstate the bug.
  const raw = measured > 1_000_000 ? measured : BLINK_MAX_LAYOUT_PX / dpr
  const px = Math.max(1, Math.floor(raw) - SAFETY_PX)
  cache = { dpr, px }
  return px
}
