import { useEffect } from 'react'
import { useSyncExternalStore } from 'react'
import { panelsStore } from '../lib/panelsStore'
import { uiStore } from '../lib/uiStore'
import { panelKeyStr } from '../../../shared/panels'

/**
 * Inset (in CSS px, before uiScale) applied to the docked native view's bounds so its hard
 * rectangular corners never cross the case card's rounded ones. The card's `PanelDock hostRef`
 * relies on this only where its own edge coincides with a rounded corner of `rounded-r3`'s
 * `--radius-r3: 10px` — see the per-edge reasoning at the call site below.
 *
 * For a rectangle to sit fully inside a rounded rect of corner radius r, each edge must be
 * inset by r * (1 - 1/sqrt(2)) ≈ 0.2929 * r.
 *
 * The r that applies here is the border's INNER curve, not `--radius-r3` itself: `hostRef` sits
 * inside the card's 1px border, and `getBoundingClientRect()` already excludes it. So
 * r = 10 - 1 = 9px -> 9 * 0.2929 ≈ 2.64px -> 3px would suffice. 4px is deliberately one pixel
 * conservative, which errs toward dead space rather than a clipped corner; do not "correct" it
 * to 3 by re-deriving from 10px and adding the border again, which double-counts.
 */
const DOCK_INSET_PX = 4

/**
 * Positions the active docked panel's native WebContentsView over `hostRef` and
 * hides every other docked panel. The view is a sibling of the DOM (it always
 * paints on top), so visibility is explicit: shown only when it is the active
 * tab, not floated, and not occluded by a modal/dialog. Bounds are multiplied by
 * the UI zoom factor because setZoomFactor scales the DOM but not native views.
 */
export function PanelDock({ hostRef }: { hostRef: React.RefObject<HTMLDivElement | null> }): null {
  const st = useSyncExternalStore(
    (cb) => panelsStore.subscribe(cb),
    () => panelsStore.get()
  )
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )

  useEffect(() => {
    const activeKeyStr = st.activeTab
    const apply = (): void => {
      for (const p of st.panels) {
        // A floated panel lives in its own BrowserWindow, which owns its view's
        // bounds + visibility. Managing it here would setVisible(false) on the
        // float window's content (it's never the active DOCKED tab) → blank window.
        if (p.floated) continue
        const k = { caseSlug: p.caseSlug, packId: p.packId, windowId: p.windowId }
        const isActive = panelKeyStr(p) === activeKeyStr
        const visible = isActive && !st.occluded
        if (visible && hostRef.current) {
          const r = hostRef.current.getBoundingClientRect()
          const z = ui.uiScale
          // hostRef (CaseWorkspace's dockHost) is `absolute inset-0` inside the sibling of
          // PanelTabStrip. PanelTabStrip used to be the card's own first child (a bar inside
          // the card), which made the host's top edge an interior seam below it, not a card
          // corner — only the bottom-left/bottom-right corners were reachable, hence the old
          // one-inset-on-y/height asymmetry. Now that PanelTabStrip is a sibling ABOVE the card
          // (case-chrome-symmetry Fix 1), the host is flush with the card's top edge too, so
          // all four corners are reachable and all four edges get the same inset. x/y both move
          // in by one inset; width/height both shrink by two (one inset on each side).
          void window.argus.panels.setBounds(k, {
            x: Math.round((r.left + DOCK_INSET_PX) * z),
            y: Math.round((r.top + DOCK_INSET_PX) * z),
            // Math.max(0, …): a zero-size layout (minimized window on some platforms) makes
            // getBoundingClientRect() return all zeros, and subtracting the inset would then
            // hand setBounds a NEGATIVE width/height — electronPlatform forwards the rect
            // unvalidated. Before the inset existed this path bottomed out at 0; keep it there.
            width: Math.max(0, Math.round((r.width - DOCK_INSET_PX * 2) * z)),
            height: Math.max(0, Math.round((r.height - DOCK_INSET_PX * 2) * z))
          })
        }
        void window.argus.panels.setVisible(k, visible)
      }
    }
    apply()
    const host = hostRef.current
    if (!host) return
    const ro = new ResizeObserver(apply)
    ro.observe(host)
    window.addEventListener('resize', apply)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', apply)
    }
  }, [st.panels, st.activeTab, st.occluded, ui.uiScale, hostRef])

  return null
}
