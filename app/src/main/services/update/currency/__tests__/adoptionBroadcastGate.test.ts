import { describe, it, expect, vi } from 'vitest'
import { createAdoptionBroadcastGate } from '../adoptionBroadcastGate'

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

describe('createAdoptionBroadcastGate', () => {
  it('broadcasts the first adoption', () => {
    const broadcast = vi.fn()
    const gate = createAdoptionBroadcastGate({ anchors: fakeAnchors(), broadcast })
    gate.onAdopted(2)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith(2)
  })

  it('two adoption fires before any ack land as exactly one broadcast', () => {
    const broadcast = vi.fn()
    const gate = createAdoptionBroadcastGate({ anchors: fakeAnchors(), broadcast })
    // Simulates a scheduled tick's batch completing and a manual surveyNow's batch completing
    // back-to-back, both faster than the renderer's ack IPC round trip.
    gate.onAdopted(1)
    gate.onAdopted(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('broadcasts again for a later adoption once the ack has landed', () => {
    const broadcast = vi.fn()
    const anchors = fakeAnchors()
    const gate = createAdoptionBroadcastGate({ anchors, broadcast })
    gate.onAdopted(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
    // The ack lands (renderer confirms the notice was shown) — this is what the real
    // `currencyAckAdopted` IPC handler calls, through the wrapped `anchors.markFirstMirrorNoticeShown`.
    gate.anchors.markFirstMirrorNoticeShown()
    // A later batch adopts something else entirely — but the persisted flag is now set, so the
    // notice was already shown once and must not fire again. (Task 7's design is "shown once
    // total", not "once per adoption".)
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
    const broadcast = vi.fn()
    const anchors = fakeAnchors()
    const gate = createAdoptionBroadcastGate({ anchors, broadcast })
    gate.onAdopted(1)
    // Still awaiting ack: a second fire before markFirstMirrorNoticeShown must still be dropped.
    gate.onAdopted(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(anchors.firstMirrorNoticeShown()).toBe(false)
  })
})
