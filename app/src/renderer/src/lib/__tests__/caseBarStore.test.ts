import { describe, it, expect, vi, beforeEach } from 'vitest'
import { caseBarStore } from '../caseBarStore'

beforeEach(() => {
  caseBarStore.reset()
})

// The `caseBarStore state` block that used to sit here is gone with the state channel itself:
// `publish`/`subscribe`/`get` existed only to keep the bar's Review button spinning through
// review's PR search, which now reports in the Pull request rail (PrCompanionSection's
// `autoSearching`). What remains is the event channel, which is unchanged.
describe('caseBarStore events', () => {
  it('delivers a mode switch to a consumer listening for that case', () => {
    const seen = vi.fn()
    const off = caseBarStore.onEventFor('case-a', seen)
    caseBarStore.emit({ kind: 'mode-switched', slug: 'case-a', mode: 'review', sessionId: 7 })
    expect(seen).toHaveBeenCalledWith({
      kind: 'mode-switched',
      slug: 'case-a',
      mode: 'review',
      sessionId: 7
    })
    off()
  })

  it('ignores an event published for a different case', () => {
    // The guard CaseWorkspace's currentSlugRef gives today does not survive a trip through
    // a singleton: without this, a switch resolved for case A would be applied by a
    // workspace that has since moved to case B, retargeting B's active chat.
    const seen = vi.fn()
    const off = caseBarStore.onEventFor('case-b', seen)
    caseBarStore.emit({ kind: 'mode-switched', slug: 'case-a', mode: 'review', sessionId: 7 })
    expect(seen).not.toHaveBeenCalled()
    off()
  })

  it('delivers errors on the same channel', () => {
    const seen = vi.fn()
    const off = caseBarStore.onEventFor('case-a', seen)
    caseBarStore.emit({ kind: 'mode-error', slug: 'case-a', message: 'nope' })
    expect(seen).toHaveBeenCalledWith({ kind: 'mode-error', slug: 'case-a', message: 'nope' })
    off()
  })

  it('stops delivering after unsubscribe', () => {
    const seen = vi.fn()
    const off = caseBarStore.onEventFor('case-a', seen)
    off()
    caseBarStore.emit({ kind: 'mode-error', slug: 'case-a', message: 'nope' })
    expect(seen).not.toHaveBeenCalled()
  })

  it('reset drops event listeners', () => {
    const seen = vi.fn()
    caseBarStore.onEventFor('case-a', seen)
    caseBarStore.reset()
    caseBarStore.emit({ kind: 'mode-error', slug: 'case-a', message: 'nope' })
    expect(seen).not.toHaveBeenCalled()
  })
})
