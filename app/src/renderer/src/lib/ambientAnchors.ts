import {
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'

/**
 * A ref callback for one anchor slot.
 *
 * It returns a cleanup function, which is a React 19 ref feature and not decoration: when a ref
 * callback returns a function, React calls THAT on detach instead of calling the ref again with
 * `null`. The cleanup closes over the element it attached, which is the only way a shared slot can
 * tell "release the node I claimed" apart from "clear whatever is in there" — see
 * {@link useAmbientAnchorState}.
 */
export type AnchorRef = (el: HTMLElement | null) => () => void

export interface AmbientAnchors {
  /** Ref callback for the view's light source — the aurora anchors to its rect.
   *  Home: the ARGUS wordmark. Case: the ambient band. Settings: the page title. */
  setLight: AnchorRef
  /** Ref callback for the element whose bottom edge the light dies at.
   *  Home: the filter row. Case: the ambient band. Settings: the header itself. */
  setCutoff: AnchorRef
}

const noop: AnchorRef = () => () => undefined

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

/**
 * Builds one claim/release ref callback over a `useState` slot.
 *
 * The release is identity-guarded — it clears the slot only if the slot still holds the very node
 * this callback attached. A bare `setState` used directly as a ref callback cannot do that: React
 * hands detach a plain `null`, so the write is indistinguishable from any other writer's, and the
 * slot degrades to last-write-wins ordered by React's commit schedule.
 */
function anchorRef(set: Dispatch<SetStateAction<HTMLElement | null>>): AnchorRef {
  return (el) => {
    if (el) set(el)
    return () => set((cur) => (cur === el ? null : cur))
  }
}

/**
 * The two anchor slots the dynamic theme steers by, plus the ref callbacks that fill them.
 *
 * WHY CLAIM/RELEASE AND NOT TWO `useState` SETTERS (regression fixed 2026-08-02): several
 * unrelated components write these two slots — the active view (home's filter row, the case
 * band) and `TopBar` (Settings' title and the header itself). They do not mount and unmount in
 * the same React commit, because `TopBar`'s anchors are gated on `settingsBarStore`, which
 * `SettingsView` clears from an unmount effect in the PASSIVE phase — one commit after the
 * destination view has already rendered and attached its own anchors.
 *
 * So leaving Settings produced this order: home attaches its `h1` and filter row (commit A), then
 * `TopBar` re-renders without a settings bar and React detaches the header's stale ref (commit B).
 * With bare setters that trailing detach wrote `null` over anchors that belonged to home, and the
 * canvas silently fell back to its hard-coded 460px cutoff — a full-height aurora on every view
 * reached from Settings. Nothing about the wiring looked wrong; only the commit order was.
 *
 * The guard makes the slot order-independent instead of merely ordered-correctly-today: a writer
 * can only ever remove its own node, so a late release from a departing component is a no-op once
 * someone else has claimed the slot, and a same-commit swap (mutation-phase detach before
 * layout-phase attach) still works because the outgoing node IS what the slot holds at that point.
 */
export function useAmbientAnchorState(): {
  light: HTMLElement | null
  cutoff: HTMLElement | null
  anchors: AmbientAnchors
} {
  const [light, setLight] = useState<HTMLElement | null>(null)
  const [cutoff, setCutoff] = useState<HTMLElement | null>(null)
  // Stable for the app's lifetime: these are ref callbacks, and a new identity each render would
  // make React detach and re-attach every anchor on every render of App.
  const anchors = useMemo<AmbientAnchors>(
    () => ({ setLight: anchorRef(setLight), setCutoff: anchorRef(setCutoff) }),
    []
  )
  return { light, cutoff, anchors }
}
