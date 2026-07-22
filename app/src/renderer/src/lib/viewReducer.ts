import type { SettingsDeepLink } from '../components/settings/SettingsView'

export type View =
  | { kind: 'home' }
  | { kind: 'case'; slug: string }
  | { kind: 'settings'; page?: SettingsDeepLink }
  | { kind: 'observability' }

export type ViewAction = { kind: 'settings'; page?: SettingsDeepLink } | { kind: 'observability' }

/**
 * Pure view-transition logic shared by the Settings and Observability toolbar
 * icons (App.tsx's `openSettings`/`openObservability`). Extracted from App so
 * the toggle rules -- including the branch below with no DOM path -- have an
 * honest, directly-testable seam.
 *
 * Toggle rules:
 *  - Observability: a click while already on Observability returns to
 *    `prevView` (toggles shut). Otherwise switches to Observability.
 *  - Settings: a click while already on Settings AND the action carries no
 *    `page` returns to `prevView` (toggles shut) -- this is what the toolbar
 *    gear does (it calls openSettings() with no page). But `openSettings` is
 *    also used to deep-link into a specific page (onboarding "rerun setup",
 *    etc.); when a `page` is given and the view is already Settings, this
 *    must switch pages instead of closing, or a deep link into an
 *    already-open Settings view would slam it shut instead of navigating.
 *    (SettingsView stays mounted across this transition -- App renders it
 *    unkeyed, and it syncs its visible page from the changed `initialPage`
 *    prop itself.)
 *
 * `prevView` bookkeeping (recording the view being left, and not overwriting
 * it when re-entering a view already active) stays the caller's job -- this
 * function only decides what the next `View` should be.
 */
export function nextView(cur: View, prevView: View, action: ViewAction): View {
  if (action.kind === 'observability') {
    if (cur.kind === 'observability') return prevView
    return { kind: 'observability' }
  }
  if (cur.kind === 'settings' && action.page === undefined) return prevView
  return { kind: 'settings', page: action.page }
}
