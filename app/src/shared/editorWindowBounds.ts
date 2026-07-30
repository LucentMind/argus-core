import { EDITOR_DEFAULT_SIZE, EDITOR_MIN_SIZE, type WindowBounds } from './editorIpc'

/** A window is "visible enough" if at least this much of it overlaps a work area on both axes.
 *  Roughly a title bar's worth — enough to grab and drag back. */
const MIN_VISIBLE = 80

function overlap(aStart: number, aSize: number, bStart: number, bSize: number): number {
  return Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart)
}

function isVisibleOn(b: WindowBounds, area: WindowBounds): boolean {
  return (
    overlap(b.x, b.width, area.x, area.width) >= MIN_VISIBLE &&
    overlap(b.y, b.height, area.y, area.height) >= MIN_VISIBLE
  )
}

/** Overlap alone is not enough: a window LARGER than the display engulfs it, so it overlaps by
 *  the display's full width and height while its title bar sits off the top edge, unreachable.
 *  Such a window must be shrunk, not left alone. */
function fitsWithin(b: WindowBounds, area: WindowBounds): boolean {
  return b.width <= area.width && b.height <= area.height
}

/**
 * Keep restored bounds usable across monitor changes. A window that still overlaps some work
 * area is left exactly as it was; anything else is resized to fit and centered on the first
 * work area, which Electron reports as the primary display.
 */
export function clampToDisplays(
  bounds: WindowBounds,
  workAreas: readonly WindowBounds[]
): WindowBounds {
  if (workAreas.some((area) => isVisibleOn(bounds, area) && fitsWithin(bounds, area))) {
    return bounds
  }

  const target = workAreas[0]
  if (!target) {
    return { x: 0, y: 0, width: EDITOR_DEFAULT_SIZE.width, height: EDITOR_DEFAULT_SIZE.height }
  }

  const width = Math.max(EDITOR_MIN_SIZE.width, Math.min(bounds.width, target.width))
  const height = Math.max(EDITOR_MIN_SIZE.height, Math.min(bounds.height, target.height))
  return {
    x: Math.round(target.x + (target.width - width) / 2),
    y: Math.round(target.y + (target.height - height) / 2),
    width,
    height
  }
}
