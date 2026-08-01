/**
 * The result of composing a review run. Pure types — no `node:*` or Electron imports (see the
 * shared/ constraint), so main, preload and renderer all agree on one shape.
 *
 * Why this is a result and not a thrown error: some of the reasons a review run cannot start
 * are not faults at all, just states the user has not got round to fixing yet. Those have to
 * survive the trip to the renderer in a form it can branch on, and a thrown error cannot —
 * `ipcRenderer.invoke` rejects with a brand-new plain Error, discarding the original class and
 * any `code` property (see shared/ipcError.ts). Recognising a blocker would then mean matching
 * an English sentence, which breaks the moment anyone rewords it. A discriminated result
 * crosses the boundary intact. Genuine faults — an unknown case, a session belonging to another
 * case, a bound PR whose local repo is missing — stay throws.
 *
 * Same shape the findings write actions already use (`postFindingComment` -> {ok:false, reason}).
 */

/**
 * A reason a review run cannot start that the user can resolve themselves, so the UI should
 * offer the next step rather than report a failure.
 */
export type ReviewRunBlocker = 'no-pr-bound'

export type ReviewRunComposition =
  { ok: true; prompt: string } | { ok: false; reason: ReviewRunBlocker }
