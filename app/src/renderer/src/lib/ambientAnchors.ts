import { createContext, useContext } from 'react'

export interface AmbientAnchors {
  /** Ref callback for the ARGUS wordmark <h1> — the aurora anchors to its rect. */
  setHero: (el: HTMLElement | null) => void
  /** Ref callback for the filter row — the light fades out at its bottom edge. */
  setFilters: (el: HTMLElement | null) => void
}

const noop = (): void => undefined

/**
 * Default no-ops so CaseDashboard can attach its anchor refs unconditionally —
 * outside a dynamic DynamicHome (classic mode, tests) they simply go nowhere.
 */
export const AmbientAnchorContext = createContext<AmbientAnchors>({
  setHero: noop,
  setFilters: noop
})

export function useAmbientAnchors(): AmbientAnchors {
  return useContext(AmbientAnchorContext)
}
