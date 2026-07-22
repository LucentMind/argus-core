// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ProposalCounts } from '../../../../shared/proposals'
import { ProposalsStore } from '../proposalsStore'

function stubArgus(records: Array<{ type: string }>): {
  fire: (c: ProposalCounts) => void
} {
  let cb: ((c: ProposalCounts) => void) | null = null
  ;(window as never as { argus: unknown }).argus = {
    proposals: {
      list: vi.fn(async () => ({ proposals: records })),
      onChanged: (fn: (c: ProposalCounts) => void): (() => void) => {
        cb = fn
        return () => {}
      }
    }
  }
  return { fire: (c) => cb?.(c) }
}

beforeEach(() => {
  // Reset the store between tests
  if (window.argus) {
    delete (window as any).argus
  }
})

describe('ProposalsStore', () => {
  it('primes counts from list() and updates from the broadcast', async () => {
    const { fire } = stubArgus([
      { type: 'skill-new' },
      { type: 'skill-new' },
      { type: 'memory-append' }
    ])
    const store = new ProposalsStore()
    store.start()
    await vi.waitFor(() => expect(store.get()?.pendingCount).toBe(3))
    expect(store.get()?.byType['skill-new']).toBe(2)
    expect(store.get()?.byType['memory-append']).toBe(1)

    fire({ pendingCount: 1, byType: { recipe: 1 } })
    expect(store.get()).toEqual({ pendingCount: 1, byType: { recipe: 1 } })
  })

  it('start() is idempotent', async () => {
    stubArgus([])
    const store = new ProposalsStore()
    store.start()
    store.start()
    await vi.waitFor(() => expect(store.get()?.pendingCount).toBe(0))
    expect(
      (window as never as { argus: { proposals: { list: ReturnType<typeof vi.fn> } } }).argus
        .proposals.list
    ).toHaveBeenCalledTimes(1)
  })
})
