import { useEffect } from 'react'
import { useSyncExternalStore } from 'react'
import { panelsStore } from '../lib/panelsStore'
import { uiStore } from '../lib/uiStore'
import { panelKeyStr } from '../../../shared/panels'

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
          void window.argus.panels.setBounds(k, {
            x: Math.round(r.left * z),
            y: Math.round(r.top * z),
            width: Math.round(r.width * z),
            height: Math.round(r.height * z)
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
