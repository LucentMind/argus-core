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
  /** The persisted flag. Structural, not the whole `CurrencyAnchorStore` — this gate only ever
   *  touches these two methods. */
  anchors: { firstMirrorNoticeShown(): boolean; markFirstMirrorNoticeShown(): void }
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
} {
  const now = deps.now ?? Date.now
  let pendingSince: number | null = null
  return {
    onAdopted: (count) => {
      if (deps.anchors.firstMirrorNoticeShown()) return
      // Evaluated lazily here, on the next call, rather than via a `setTimeout` — nothing to
      // clear on shutdown, and no behaviour depends on the expiry firing at an exact instant.
      if (pendingSince !== null && now() - pendingSince < PENDING_WINDOW_MS) return
      pendingSince = now()
      deps.broadcast(count)
    },
    anchors: {
      firstMirrorNoticeShown: () => deps.anchors.firstMirrorNoticeShown(),
      markFirstMirrorNoticeShown: () => {
        pendingSince = null
        deps.anchors.markFirstMirrorNoticeShown()
      }
    }
  }
}
