export interface AdoptionBroadcastGateDeps {
  /** The persisted flag. Structural, not the whole `CurrencyAnchorStore` — this gate only ever
   *  touches these two methods. */
  anchors: { firstMirrorNoticeShown(): boolean; markFirstMirrorNoticeShown(): void }
  broadcast: (count: number) => void
}

/**
 * Wraps the persisted `firstMirrorNoticeShown` flag with an in-memory "broadcast sent, awaiting
 * ack" latch.
 *
 * The persisted flag alone is not enough to guarantee a single broadcast: it is set
 * asynchronously, by the renderer's `currency:ack-adopted` round trip, well after `onAdopted`
 * fires in the main process. Two `applyPending()` batches that complete back-to-back — a
 * scheduled tick landing right after a user-triggered `surveyNow()`, say — can both run before
 * that round trip lands. Both would read `firstMirrorNoticeShown() === false` and both broadcast,
 * so the renderer would push (and re-ack) the notice twice. The in-memory `pending` latch closes
 * that window: the first `onAdopted` call sets it immediately (synchronously, no IPC involved),
 * so a second call arriving before the ack lands sees `pending === true` and is dropped. Cleared
 * only when the real ack lands, via the wrapped `markFirstMirrorNoticeShown`.
 */
export function createAdoptionBroadcastGate(deps: AdoptionBroadcastGateDeps): {
  /** Pass as `CurrencyService`'s `onAdopted` dep. */
  onAdopted: (count: number) => void
  /** Pass as `registerCurrencyIpc`'s `anchors` dep. */
  anchors: { firstMirrorNoticeShown(): boolean; markFirstMirrorNoticeShown(): void }
} {
  let pending = false
  return {
    onAdopted: (count) => {
      if (deps.anchors.firstMirrorNoticeShown() || pending) return
      pending = true
      deps.broadcast(count)
    },
    anchors: {
      firstMirrorNoticeShown: () => deps.anchors.firstMirrorNoticeShown(),
      markFirstMirrorNoticeShown: () => {
        pending = false
        deps.anchors.markFirstMirrorNoticeShown()
      }
    }
  }
}
