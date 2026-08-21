import { describe, it, expect, vi } from 'vitest'
import { createAdoptionBroadcastGate, PENDING_WINDOW_MS } from '../adoptionBroadcastGate'

function fakeAnchors(): {
  firstMirrorNoticeShown: () => boolean
  markFirstMirrorNoticeShown: () => void
} {
  let shown = false
  return {
    firstMirrorNoticeShown: () => shown,
    markFirstMirrorNoticeShown: () => {
      shown = true
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
  })
})
