/**
 * How long a broadcast's "awaiting ack" latch is honoured before it is treated as stale and a
 * later adoption is allowed through again.
 *
 * The latch's only legitimate job is coalescing two `applyPending()` batches that complete
 * back-to-back, faster than the renderer's `currency:ack-adopted` IPC round trip — a sub-second
 * window on any real machine. 60s is comfortably longer than that (so it never falsely coalesces
 * two genuinely separate adoptions) and comfortably shorter than a session (so an ack that never
 * arrives — because it broadcast with no case open, and `TopBar` correctly never subscribed —
 * cannot wedge the latch shut for the rest of the process, silently swallowing every later
 * adoption until a full restart).
 */
export const PENDING_WINDOW_MS = 60_000

export interface AdoptionBroadcastGateDeps {
  /** The persisted flag and pending count. Structural, not the whole `CurrencyAnchorStore` — this
   *  gate only ever touches these four methods. */
  anchors: {
    firstMirrorNoticeShown(): boolean
    markFirstMirrorNoticeShown(): void
    pendingAdoptedCount(): number
    setPendingAdoptedCount(n: number): void
  }
  broadcast: (count: number) => void
  /** Injected, not `Date.now()` directly, so the window's expiry is deterministic under fake
   *  timers. Defaults to `Date.now` for real callers. */
  now?: () => number
}

/**
 * Wraps the persisted `firstMirrorNoticeShown` flag with a TIME-BOUNDED "broadcast sent, awaiting
 * ack" latch.
 *
 * The persisted flag alone is not enough to guarantee a single broadcast: it is set
 * asynchronously, by the renderer's `currency:ack-adopted` round trip, well after `onAdopted`
 * fires in the main process. Two `applyPending()` batches that complete back-to-back — a
 * scheduled tick landing right after a user-triggered `surveyNow()`, say — can both run before
 * that round trip lands. Both would read `firstMirrorNoticeShown() === false` and both broadcast,
 * so the renderer would push (and re-ack) the notice twice. The in-memory latch closes that
 * window: the first `onAdopted` call stamps `pendingSince` immediately (synchronously, no IPC
 * involved), so a second call arriving inside `PENDING_WINDOW_MS` sees it and is dropped.
 *
 * The latch is time-bounded rather than cleared ONLY by a real ack, because an ack is not
 * guaranteed to ever arrive: `TopBar` deliberately does not subscribe to `currency:adopted` while
 * no case is open (see `TopBar.tsx`), so a broadcast that goes out in that state reaches nobody
 * and nobody acks it. An indefinite latch would then stay stuck forever, silently dropping every
 * later adoption for the rest of the process — reproducing the exact "notice never shown" failure
 * this whole gate exists to prevent, just through a different door. A real ack still clears the
 * latch outright, immediately, regardless of the window.
 */
export function createAdoptionBroadcastGate(deps: AdoptionBroadcastGateDeps): {
  /** Pass as `CurrencyService`'s `onAdopted` dep. */
  onAdopted: (count: number) => void
  /** Pass as `registerCurrencyIpc`'s `anchors` dep. */
  anchors: { firstMirrorNoticeShown(): boolean; markFirstMirrorNoticeShown(): void }
  /**
   * The count from the most recent broadcast that has not yet been acknowledged — 0 once acked,
   * or once the underlying flag was already persisted as shown. This is the queryable half of
   * Finding 1's fix: a batch adopted while no case was open broadcasts `currency:adopted` into the
   * void (TopBar deliberately does not subscribe in that state), and on the likeliest path — the
   * very first mirror run — no LATER batch ever arrives to give the notice a second chance, since
   * everything adoptable has already been adopted. Retaining the count here lets a case that opens
   * afterwards recover it by asking, instead of the batch being lost the moment its broadcast goes
   * unheard.
   *
   * PERSISTED, not an in-memory closure variable (Important 2, second whole-branch review): the
   * likeliest real trigger of the first mirror run is the moment the user opens Settings (which
   * itself surveys), and a user who then configures things and quits without ever opening a case
   * would otherwise lose the count the instant the process exits — with no later batch to recover
   * it, since everything adoptable is already adopted. Reads through to `anchors`, which is the
   * SAME `currency.json` `firstMirrorNoticeShown` lives in, so a gate rebuilt in a later process
   * sees whatever the previous process last wrote here.
   */
  pendingCount: () => number
} {
  const now = deps.now ?? Date.now
  let pendingSince: number | null = null
  return {
    onAdopted: (count) => {
      if (deps.anchors.firstMirrorNoticeShown()) return
      // Evaluated lazily here, on the next call, rather than via a `setTimeout` — nothing to
      // clear on shutdown, and no behaviour depends on the expiry firing at an exact instant.
      // This half stays IN-MEMORY and process-scoped on purpose: it only ever coalesces two
      // applyPending() batches finishing back-to-back within the same run (see the module
      // docblock), and persisting it would resurrect exactly the indefinite hold Fix wave 2 (see
      // the module docblock) removed — a stale window surviving a restart could suppress a
      // brand-new adoption in the next process for no reason.
      if (pendingSince !== null && now() - pendingSince < PENDING_WINDOW_MS) return
      pendingSince = now()
      deps.anchors.setPendingAdoptedCount(count)
      deps.broadcast(count)
    },
    anchors: {
      firstMirrorNoticeShown: () => deps.anchors.firstMirrorNoticeShown(),
      markFirstMirrorNoticeShown: () => {
        pendingSince = null
        // Clears the persisted count too — see `CurrencyAnchorStore.markFirstMirrorNoticeShown`,
        // which writes both in one go.
        deps.anchors.markFirstMirrorNoticeShown()
      }
    },
    pendingCount: () => deps.anchors.pendingAdoptedCount()
  }
}
