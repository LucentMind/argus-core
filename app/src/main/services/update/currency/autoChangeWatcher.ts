/**
 * Detects a change in `updates.auto` across successive settings snapshots, so `main/index.ts` can
 * call `CurrencyService.republish()` exactly when the toggle actually moves — not on every
 * unrelated settings edit, which would spam a broadcast, and not never, which is Critical 1 from
 * the whole-branch review: turning auto-update off left the TopBar badge and the Sources/Team nav
 * dots stuck showing a stale positive count (`payload().auto` still `true`) until the next survey
 * or an app restart, because nothing published a fresh payload when only the setting changed.
 *
 * Stateful, unlike its sibling `forgetHooks`: "changed" is a comparison against the PREVIOUS
 * reading, not a fact derivable from one snapshot, so this cannot be a pure function the way
 * `forgetHooks`' key construction is. Lives here, not inline in `main/index.ts`, for the same
 * reason `forgetHooks` does: `main/index.ts` has no test harness, and a near-miss here (comparing
 * against the wrong baseline, or firing on every settings change instead of just this field) would
 * silently no-op with a fully green suite.
 */
export function createAutoChangeWatcher(deps: { getAuto: () => boolean; onChange: () => void }): {
  check: () => void
} {
  let last = deps.getAuto()
  return {
    check: (): void => {
      const cur = deps.getAuto()
      if (cur === last) return
      last = cur
      deps.onChange()
    }
  }
}
