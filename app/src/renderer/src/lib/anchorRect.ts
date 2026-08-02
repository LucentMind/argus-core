/** Split out of AmbientCanvas.tsx: react-refresh/only-export-components forbids
 *  a component file from exporting anything but components (and types) — see
 *  [[argus-renderer-lint-traps]].
 *
 *  An anchor's rect in canvas space.
 *
 *  The canvas is `position: fixed` at the window's top-left (spec
 *  2026-08-01-header-window-controls-design.md §4.1), so an element's viewport rect is already in
 *  canvas space — except for scroll. `refresh()` runs on resize, on props change, and on font
 *  load; never on scroll. Without the correction below, a resize taken while home is scrolled
 *  down would re-measure the greeting at its scrolled position and jump the blob to it. Adding
 *  the ancestors' `scrollTop` back pins every anchor to where it sits at rest.
 *
 *  On case and settings every `scrollTop` in the chain is 0 (their headers do not scroll — only
 *  the region below them does, in its own container), so this is a no-op there.
 *
 *  Exported for its own unit test: jsdom returns null from `getContext('webgl2')`, so the
 *  component always takes its fallback path there and `refresh()` is unreachable from a test. */
export function anchorRect(el: HTMLElement): {
  x: number
  y: number
  width: number
  height: number
  bottom: number
} {
  const r = el.getBoundingClientRect()
  let sy = 0
  for (let n = el.parentElement; n; n = n.parentElement) sy += n.scrollTop
  return { x: r.x, y: r.y + sy, width: r.width, height: r.height, bottom: r.bottom + sy }
}
