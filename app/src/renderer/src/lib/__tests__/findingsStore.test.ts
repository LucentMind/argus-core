// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { findingsStore, wireFindingsStore } from '../findingsStore'
import type { FindingRow } from '../../../../shared/observability'

const row = (over: Partial<FindingRow>): FindingRow =>
  ({
    id: 1,
    caseId: 1,
    sessionId: 1,
    summary: 's',
    reviewState: 'pending',
    mode: 'investigation',
    role: null,
    status: 'confirmed',
    roleSource: null,
    causedBy: null,
    supersededBy: null,
    body: 'b',
    ...over
  }) as FindingRow

let list: ReturnType<typeof vi.fn>
let review: ReturnType<typeof vi.fn>
let del: ReturnType<typeof vi.fn>
let update: ReturnType<typeof vi.fn>
let onEvent: ReturnType<typeof vi.fn>

beforeEach(() => {
  findingsStore.clearForTests()
  list = vi.fn()
  review = vi.fn()
  del = vi.fn().mockResolvedValue({ deleted: true })
  update = vi.fn()
  onEvent = vi.fn(() => () => {})
  window.argus = {
    findings: { list, review, delete: del, update },
    agent: { onEvent }
  } as never
})

describe('findingsStore', () => {
  it('loads rows per slug and reports loaded', async () => {
    list.mockResolvedValue([row({ id: 1 })])
    expect(findingsStore.get('c1')).toEqual({ rows: [], loaded: false, error: null })
    await findingsStore.load('c1')
    expect(findingsStore.get('c1').rows.map((r) => r.id)).toEqual([1])
    expect(findingsStore.get('c1').loaded).toBe(true)
    expect(findingsStore.get('c2').rows).toEqual([])
  })

  it('keeps the last-known rows when a refetch fails, and records the error', async () => {
    list.mockResolvedValueOnce([row({ id: 1 })]).mockRejectedValueOnce(new Error('boom'))
    await findingsStore.load('c1')
    await findingsStore.load('c1')
    expect(findingsStore.get('c1').rows).toHaveLength(1)
    expect(findingsStore.get('c1').loaded).toBe(true)
    expect(findingsStore.get('c1').error).toBe('boom')
  })

  it('review toggles the active state back to pending, merges the row and keeps the body', async () => {
    list.mockResolvedValue([row({ id: 1, reviewState: 'accepted' })])
    await findingsStore.load('c1')
    review.mockResolvedValue({ id: 1, reviewState: 'pending', reviewActor: null })
    await findingsStore.review('c1', 1, 'accepted')
    expect(review).toHaveBeenCalledWith(1, 'pending', undefined)
    expect(findingsStore.get('c1').rows[0]).toMatchObject({ reviewState: 'pending', body: 'b' })
  })

  it('review with a reason never toggles: same state, reason forwarded', async () => {
    list.mockResolvedValue([row({ id: 1, reviewState: 'rejected' })])
    await findingsStore.load('c1')
    review.mockResolvedValue({ id: 1, reviewState: 'rejected', rejectTag: 'wrong' })
    await findingsStore.review('c1', 1, 'rejected', { tag: 'wrong' })
    expect(review).toHaveBeenCalledWith(1, 'rejected', { tag: 'wrong' })
    expect(findingsStore.get('c1').rows[0].rejectTag).toBe('wrong')
  })

  it('update sends the patch and merges the returned row onto the local one', async () => {
    list.mockResolvedValue([row({ id: 1, role: null, causedBy: null })])
    await findingsStore.load('c1')
    update.mockResolvedValue({ ...row({ id: 1 }), role: 'symptom', causedBy: 4, body: undefined })
    const out = await findingsStore.update('c1', 1, { role: 'symptom', causedBy: 4 })
    expect(update).toHaveBeenCalledWith(1, { role: 'symptom', causedBy: 4 })
    expect(out?.role).toBe('symptom')
    const local = findingsStore.get('c1').rows[0]
    expect(local.causedBy).toBe(4)
    expect(local.body).toBe('b') // merged, not swapped
  })

  it('update rethrows a refusal and leaves the row as it was', async () => {
    list.mockResolvedValue([row({ id: 1 })])
    await findingsStore.load('c1')
    update.mockRejectedValue(new Error('That would make a loop in the chain.'))
    await expect(findingsStore.update('c1', 1, { causedBy: 2 })).rejects.toThrow('loop')
    expect(findingsStore.get('c1').rows[0].causedBy).toBeNull()
  })

  it('remove deletes through IPC and drops the row', async () => {
    list.mockResolvedValue([row({ id: 1 }), row({ id: 2 })])
    await findingsStore.load('c1')
    await findingsStore.remove('c1', 1)
    expect(del).toHaveBeenCalledWith(1)
    expect(findingsStore.get('c1').rows.map((r) => r.id)).toEqual([2])
  })

  it('notifies subscribers on every change', async () => {
    const cb = vi.fn()
    findingsStore.subscribe(cb)
    list.mockResolvedValue([])
    await findingsStore.load('c1')
    expect(cb).toHaveBeenCalled()
  })

  it('wireFindingsStore reloads the case on finding events', async () => {
    list.mockResolvedValue([row({ id: 7 })])
    wireFindingsStore()
    const handler = onEvent.mock.calls[0][0] as (e: unknown) => void
    handler({ type: 'case.finding.added', caseSlug: 'c9', sessionId: 1, payload: { markdown: '' } })
    await vi.waitFor(() => expect(findingsStore.get('c9').rows.map((r) => r.id)).toEqual([7]))
    handler({ type: 'content.delta', caseSlug: 'c9', sessionId: 1, payload: { text: '' } })
    expect(list).toHaveBeenCalledTimes(1)
  })
  it('a thumbs-down on an agent-retracted row writes a human reject instead of toggling it back to pending', async () => {
    list.mockResolvedValue([
      row({ id: 1, reviewState: 'rejected', reviewActor: 'agent', reviewReason: 'old build' })
    ])
    await findingsStore.load('c1')
    review.mockResolvedValue(row({ id: 1, reviewState: 'rejected', reviewActor: 'human' }))
    await findingsStore.review('c1', 1, 'rejected')
    expect(review).toHaveBeenCalledWith(1, 'rejected', undefined)
    expect(findingsStore.get('c1').rows[0].reviewActor).toBe('human')
  })
  it('a repeated thumb on a human review still returns the row to pending', async () => {
    list.mockResolvedValue([row({ id: 1, reviewState: 'rejected', reviewActor: 'human' })])
    await findingsStore.load('c1')
    review.mockResolvedValue(row({ id: 1, reviewState: 'pending', reviewActor: null }))
    await findingsStore.review('c1', 1, 'rejected')
    expect(review).toHaveBeenCalledWith(1, 'pending', undefined)
  })
})
