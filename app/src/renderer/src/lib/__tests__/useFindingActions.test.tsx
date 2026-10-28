// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, renderHook, screen, type RenderHookResult } from '@testing-library/react'
import { useFindingActions } from '../useFindingActions'
import { findingsStore } from '../findingsStore'
import { confirm } from '../confirmStore'
import type { FindingRow } from '../../../../shared/observability'

vi.mock('../confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

const row = (over: Partial<FindingRow>): FindingRow =>
  ({
    id: 1,
    caseId: 1,
    sessionId: 1,
    summary: 'Finding one',
    reviewState: 'pending',
    reviewActor: null,
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
let update: ReturnType<typeof vi.fn>
let del: ReturnType<typeof vi.fn>

beforeEach(async () => {
  findingsStore.clearForTests()
  vi.mocked(confirm).mockReset().mockResolvedValue(true)
  list = vi.fn().mockResolvedValue([row({ id: 1 }), row({ id: 2, summary: 'Finding two' })])
  review = vi.fn()
  update = vi.fn()
  del = vi.fn().mockResolvedValue({ deleted: true })
  window.argus = {
    findings: { list, review, update, delete: del },
    agent: { onEvent: vi.fn(() => () => {}) }
  } as never
  await findingsStore.load('c1')
})

const hook = (ruledOut = true): RenderHookResult<ReturnType<typeof useFindingActions>, unknown> =>
  renderHook(() => useFindingActions('c1', { sessionId: 1, ruledOut }))

describe('useFindingActions', () => {
  it('a fresh reject opens the strip and RULED OUT; a repeat thumb toggles back and closes it', async () => {
    const { result } = hook()
    review.mockResolvedValueOnce(row({ id: 1, reviewState: 'rejected', reviewActor: 'human' }))
    await act(() => result.current.setReview(1, 'rejected'))
    expect(review).toHaveBeenLastCalledWith(1, 'rejected', undefined)
    expect(result.current.rejectingId).toBe(1)
    expect(result.current.showRuledOut).toBe(true)

    review.mockResolvedValueOnce(row({ id: 1, reviewState: 'pending' }))
    await act(() => result.current.setReview(1, 'rejected'))
    // The store's toggle: the same thumb again returns the finding to pending.
    expect(review).toHaveBeenLastCalledWith(1, 'pending', undefined)
    expect(result.current.rejectingId).toBeNull()
  })

  it('a reject leaves RULED OUT as it was when the caller has no RULED OUT section', async () => {
    const { result } = hook(false)
    review.mockResolvedValueOnce(row({ id: 1, reviewState: 'rejected', reviewActor: 'human' }))
    await act(() => result.current.setReview(1, 'rejected'))
    expect(result.current.rejectingId).toBe(1)
    expect(result.current.showRuledOut).toBe(false)
  })

  it('a reason pick that fails to save keeps the strip open; one that saves closes it', async () => {
    const { result } = hook()
    review.mockResolvedValueOnce(null)
    await act(() => result.current.setReview(1, 'rejected', { tag: 'wrong' }))
    expect(result.current.rejectingId).toBe(1)
    review.mockResolvedValueOnce(row({ id: 1, reviewState: 'rejected', rejectTag: 'wrong' }))
    await act(() => result.current.setReview(1, 'rejected', { tag: 'wrong' }))
    expect(result.current.rejectingId).toBeNull()
  })

  it('an edit refusal is the line under that card, and only that card', async () => {
    const { result } = hook()
    update.mockRejectedValueOnce(new Error('That would make a loop in the chain.'))
    await act(() => result.current.edit(1, { causedBy: 2 }))
    render(
      <>
        <div data-testid="one">{result.current.footer(row({ id: 1 }))}</div>
        <div data-testid="two">{result.current.footer(row({ id: 2 }))}</div>
      </>
    )
    expect(screen.getByTestId('one')).toHaveTextContent('That would make a loop in the chain.')
    expect(screen.getByTestId('two')).toBeEmptyDOMElement()
  })

  it('delete confirms with the summary, and a failure is shown under the card that stays', async () => {
    const { result } = hook()
    del.mockRejectedValueOnce(new Error('Unknown finding: 1'))
    await act(() => result.current.remove(1))
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Delete finding?', message: 'Finding one', danger: true })
    )
    expect(result.current.editError).toEqual({ id: 1, message: 'Unknown finding: 1' })
    expect(findingsStore.get('c1').rows.map((r) => r.id)).toEqual([1, 2])
  })

  it('a dismissed delete confirm deletes nothing', async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false)
    const { result } = hook()
    await act(() => result.current.remove(1))
    expect(del).not.toHaveBeenCalled()
  })

  it('the footer renders the reject strip only where the caller allows it', async () => {
    const { result } = hook()
    act(() => result.current.openStrip(1))
    const { rerender } = render(<div data-testid="f">{result.current.footer(row({ id: 1 }))}</div>)
    expect(screen.getByTestId('finding-reject-strip')).toBeInTheDocument()
    rerender(<div data-testid="f">{result.current.footer(row({ id: 1 }), { strip: false })}</div>)
    expect(screen.getByTestId('f')).toBeEmptyDOMElement()
  })
})
