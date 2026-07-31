import { createContext, useContext } from 'react'

export interface AmbientAnchors {
  /** Ref callback for the view's light source — the aurora anchors to its rect.
   *  Home: the ARGUS wordmark. Case: the case-id menu button. Settings: the page title. */
  setLight: (el: HTMLElement | null) => void
  /** Ref callback for the element whose bottom edge the light dies at.
   *  Home: the filter row. Case: the header. Settings: the masthead. */
  setCutoff: (el: HTMLElement | null) => void
}

const noop = (): void => undefined

/**
 * Default no-ops so views can attach their anchor refs unconditionally —
 * outside a dynamic DynamicScope (classic mode, tests) they simply go nowhere.
 */
export const AmbientAnchorContext = createContext<AmbientAnchors>({
  setLight: noop,
  setCutoff: noop
})

export function useAmbientAnchors(): AmbientAnchors {
  return useContext(AmbientAnchorContext)
}
