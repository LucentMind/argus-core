import { useEffect, type RefObject } from 'react'

/**
 * Cursor-tracked glass lighting: writes `--mx`/`--my` (card-local px) onto the
 * hovered `.glass-card` inside `ref`, which the gc-ring/gc-sheen gradients in
 * theme-dynamic.css read. One delegated listener on the grid, rAF-throttled.
 * `active: false` attaches nothing — classic mode pays zero cost.
 */
export function useGlassPointer(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const grid = ref.current
    if (!active || !grid) return

    let pending: { card: HTMLElement; x: number; y: number } | null = null
    let raf = 0
    const flush = (): void => {
      raf = 0
      if (!pending) return
      const { card, x, y } = pending
      const r = card.getBoundingClientRect()
      card.style.setProperty('--mx', `${(x - r.left).toFixed(1)}px`)
      card.style.setProperty('--my', `${(y - r.top).toFixed(1)}px`)
    }
    const onMove = (e: PointerEvent): void => {
      const card = (e.target as Element | null)?.closest?.('.glass-card')
      if (!(card instanceof HTMLElement)) return
      pending = { card, x: e.clientX, y: e.clientY }
      if (!raf) raf = requestAnimationFrame(flush)
    }
    const onOut = (e: PointerEvent): void => {
      const card = (e.target as Element | null)?.closest?.('.glass-card')
      if (card instanceof HTMLElement && !card.contains(e.relatedTarget as Node | null)) {
        card.style.removeProperty('--mx')
        card.style.removeProperty('--my')
      }
    }

    grid.addEventListener('pointermove', onMove, { passive: true })
    grid.addEventListener('pointerout', onOut, { passive: true })
    return () => {
      grid.removeEventListener('pointermove', onMove)
      grid.removeEventListener('pointerout', onOut)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [ref, active])
}
