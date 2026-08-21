import { describe, it, expect, vi } from 'vitest'
import { createAdoptionBroadcastGate, PENDING_WINDOW_MS } from '../adoptionBroadcastGate'

/** Models the two fields `CurrencyAnchorStore` actually persists in `currency.json` — a shared,
 *  mutable "file" so two gates built over the SAME `fakeAnchors()` instance behave like two
 *  processes reading and writing one disk file (Important 2). */
function fakeAnchors(): {
  firstMirrorNoticeShown: () => boolean
  markFirstMirrorNoticeShown: () => void
  pendingAdoptedCount: () => number
  setPendingAdoptedCount: (n: number) => void
} {
  let shown = false
  let pending = 0
  return {
    firstMirrorNoticeShown: () => shown,
    markFirstMirrorNoticeShown: () => {
      shown = true
      // Real `CurrencyAnchorStore.markFirstMirrorNoticeShown` clears the persisted count in the
      // same write — see anchors.ts.
      pending = 0
    },
    pendingAdoptedCount: () => pending,
    setPendingAdoptedCount: (n) => {
      pending = n
    }
  }
}

/** A manually-advanced clock, so the window's expiry is deterministic rather than depending on
 *  real elapsed wall-clock time between statements. */
function manualClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    }
  }
}

describe('createAdoptionBroadcastGate', () => {
  it('broadcasts the first adoption', () => {
    const broadcast = vi.fn()
    const gate = createAdoptionBroadcastGate({ anchors: fakeAnchors(), broadcast })
    gate.onAdopted(2)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith(2)
  })

  it('two adoption fires inside the window, with no ack, land as exactly one broadcast', () => {
    const clock = manualClock()
    const broadcast = vi.fn()
    const gate = createAdoptionBroadcastGate({
      anchors: fakeAnchors(),
      broadcast,
      now: clock.now
    })
    // Simulates a scheduled tick's batch completing and a manual surveyNow's batch completing
    // back-to-back, both faster than the renderer's ack IPC round trip.
    gate.onAdopted(1)
    clock.advance(500)
    gate.onAdopted(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  // Fix wave 2 (review: CRITICAL). An indefinite latch, cleared ONLY by a real ack, has no path
  // to recovery when the ack never lands — which is exactly what happens by design when the first
  // broadcast goes out with no case open (TopBar deliberately never subscribes in that state, so
  // nobody acks it). Without a time bound, every later adoption for the rest of the process would
  // silently be dropped: the original "notice never shown" failure, reached through this file
  // instead of through TopBar.
  it('a fire, no ack, then a fire AFTER the window produces two broadcasts', () => {
    const clock = manualClock()
    const broadcast = vi.fn()
    const gate = createAdoptionBroadcastGate({
      anchors: fakeAnchors(),
      broadcast,
      now: clock.now
    })
    gate.onAdopted(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
    // No ack ever lands (e.g. the broadcast went out with no case open) — the latch must not
    // stay stuck forever.
    clock.advance(PENDING_WINDOW_MS + 1)
    gate.onAdopted(1)
    expect(broadcast).toHaveBeenCalledTimes(2)
  })

  // Proves the two suppression mechanisms are distinct: once a real ack lands, a later fire is
  // suppressed by the PERSISTED flag, not by the (already-cleared, and by now long-expired) latch.
  it('an ack inside the window suppresses a later fire via the persisted flag, not the latch', () => {
    const clock = manualClock()
    const broadcast = vi.fn()
    const anchors = fakeAnchors()
    const gate = createAdoptionBroadcastGate({ anchors, broadcast, now: clock.now })
    gate.onAdopted(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
    clock.advance(10) // well inside the window
    // The ack lands (renderer confirms the notice was shown) — this is what the real
    // `currencyAckAdopted` IPC handler calls, through the wrapped `anchors.markFirstMirrorNoticeShown`.
    gate.anchors.markFirstMirrorNoticeShown()
    // Advance well past the window too, so if suppression were (wrongly) still coming from the
    // latch, this fire would sail through — proving any suppression here has to be the flag.
    clock.advance(PENDING_WINDOW_MS + 1)
    gate.onAdopted(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('never broadcasts once the underlying flag is already persisted as shown', () => {
    const broadcast = vi.fn()
    const anchors = fakeAnchors()
    anchors.markFirstMirrorNoticeShown() // e.g. set on a previous launch
    const gate = createAdoptionBroadcastGate({ anchors, broadcast })
    gate.onAdopted(5)
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('clears the in-memory latch when the wrapped anchors.markFirstMirrorNoticeShown runs, not before', () => {
    const clock = manualClock()
    const broadcast = vi.fn()
    const anchors = fakeAnchors()
    const gate = createAdoptionBroadcastGate({ anchors, broadcast, now: clock.now })
    gate.onAdopted(1)
    // Still awaiting ack, still well inside the window: a second fire must still be dropped.
    clock.advance(5)
    gate.onAdopted(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(anchors.firstMirrorNoticeShown()).toBe(false)
  })

  // Finding 1: a batch that adopted while no case was open broadcasts into the void — nobody was
  // subscribed to turn it into a notice. Retaining the count here is what lets a LATER case-open
  // recover it (TopBar queries this once on the transition), instead of that batch being lost the
  // moment its broadcast goes unheard.
  describe('pendingCount', () => {
    it('is 0 before anything has been adopted', () => {
      const gate = createAdoptionBroadcastGate({ anchors: fakeAnchors(), broadcast: vi.fn() })
      expect(gate.pendingCount()).toBe(0)
    })

    it('retains the count of the most recent broadcast while unacked', () => {
      const gate = createAdoptionBroadcastGate({ anchors: fakeAnchors(), broadcast: vi.fn() })
      gate.onAdopted(4)
      expect(gate.pendingCount()).toBe(4)
    })

    it('goes back to 0 once the renderer acknowledges it', () => {
      const gate = createAdoptionBroadcastGate({ anchors: fakeAnchors(), broadcast: vi.fn() })
      gate.onAdopted(4)
      gate.anchors.markFirstMirrorNoticeShown()
      expect(gate.pendingCount()).toBe(0)
    })

    it('does not update the retained count for a fire suppressed by the coalescing window', () => {
      const clock = manualClock()
      const gate = createAdoptionBroadcastGate({
        anchors: fakeAnchors(),
        broadcast: vi.fn(),
        now: clock.now
      })
      gate.onAdopted(2)
      clock.advance(500) // well inside PENDING_WINDOW_MS
      gate.onAdopted(9) // suppressed — no broadcast, so no new count either
      expect(gate.pendingCount()).toBe(2)
    })

    // Important 2 (second whole-branch review): a pending count kept only in the gate's own
    // closure dies with the process. The likeliest real trigger of the first mirror run is the
    // user opening Settings (which itself surveys) — if they quit without ever opening a case, an
    // in-memory-only count is gone the moment the process exits, and no later batch ever arrives
    // to recover it (everything adoptable is already adopted). Persisting through `anchors` (the
    // same object `CurrencyAnchorStore` backs with `currency.json`) is what lets a gate rebuilt in
    // a LATER process — modeled here as a second `createAdoptionBroadcastGate` over the same
    // `fakeAnchors()` instance — still answer the query correctly.
    it('a pending count survives a gate rebuilt from the same anchors store', () => {
      const anchors = fakeAnchors()
      const before = createAdoptionBroadcastGate({ anchors, broadcast: vi.fn() })
      before.onAdopted(7)
      // Simulates a restart: a brand-new gate instance, zero in-memory state, same backing store.
      const after = createAdoptionBroadcastGate({ anchors, broadcast: vi.fn() })
      expect(after.pendingCount()).toBe(7)
    })

    it('an ack through the rebuilt gate clears the count the earlier gate persisted', () => {
      const anchors = fakeAnchors()
      const before = createAdoptionBroadcastGate({ anchors, broadcast: vi.fn() })
      before.onAdopted(7)
      const after = createAdoptionBroadcastGate({ anchors, broadcast: vi.fn() })
      after.anchors.markFirstMirrorNoticeShown()
      expect(after.pendingCount()).toBe(0)
      // And the earlier (still-live, in a real process this would not coexist, but the object
      // under test is `anchors` itself) gate reads the same cleared value — proving the count
      // lives in the shared store, not either gate's own closure.
      expect(before.pendingCount()).toBe(0)
    })

    // Belt-and-braces (Finding 2, minors fix wave): `fakeAnchors()` above always keeps the flag
    // and the count in sync, because it mirrors the real `CurrencyAnchorStore`, which clears both
    // in a SINGLE `store.write` (see anchors.ts, pinned atomic by anchors.test.ts). This state is
    // UNREACHABLE today through that store. It models what a future write-split (or a write that
    // throws after the in-memory latch is already cleared) could leave behind on disk: the flag
    // persisted true, the count stale and nonzero — reaching in directly, bypassing the coupled
    // fake, since no real call sequence produces it. `pendingCount()` must not trust the stale
    // count once the flag says the notice was already shown.
    it('reads 0 once the flag is true, even if the persisted count has drifted stale', () => {
      const anchors = {
        firstMirrorNoticeShown: () => true,
        markFirstMirrorNoticeShown: vi.fn(),
        pendingAdoptedCount: () => 5,
        setPendingAdoptedCount: vi.fn()
      }
      const gate = createAdoptionBroadcastGate({ anchors, broadcast: vi.fn() })
      expect(gate.pendingCount()).toBe(0)
    })
  })
})
