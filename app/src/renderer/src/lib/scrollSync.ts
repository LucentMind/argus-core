/** The three numbers this needs off a scroller. `HTMLElement` satisfies it structurally, which
 *  keeps the math testable without a DOM. */
export interface Scrollable {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/**
 * Spec §5.5: scroll sync is proportional by scroll fraction, not heading-anchored. Approximate
 * by design — a heading-to-heading mapping table is not worth the machinery (§10).
 */
export function scrollFractionOf(el: Scrollable): number {
  const range = el.scrollHeight - el.clientHeight
  // Content shorter than its pane has no meaningful position. Returning 0 rather than dividing
  // keeps NaN out of the other pane's `scrollTop`, where it would pin it silently at 0.
  if (range <= 0) return 0
  return Math.min(Math.max(el.scrollTop / range, 0), 1)
}

export function scrollTopForFraction(el: Omit<Scrollable, 'scrollTop'>, fraction: number): number {
  const range = el.scrollHeight - el.clientHeight
  if (range <= 0) return 0
  return Math.min(Math.max(fraction, 0), 1) * range
}
