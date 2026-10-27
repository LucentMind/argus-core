// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { act, renderHook, type RenderHookResult } from '@testing-library/react'
import { createRef } from 'react'
import { useReviewWalk } from '../useReviewWalk'
import { findingsStore } from '../findingsStore'
import { buildFindingTree } from '../../../../shared/findingTree'
import type { FindingRow } from '../../../../shared/observability'

type WalkTree = ReturnType<typeof buildFindingTree<FindingRow>>

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
    ...over
  }) as FindingRow

const rows = (): FindingRow[] => [
  row({ id: 6, role: 'root-cause', reviewState: 'accepted' }),
  row({ id: 4, role: 'contributing', causedBy: 6 }),
  row({ id: 2, role: 'symptom', causedBy: 4 }),
  row({ id: 7, status: 'hypothesis' })
]
const key = (k: string, target: Partial<HTMLElement> = { tagName: 'DIV' }): React.KeyboardEvent =>
  ({
    key: k,
    target,
    defaultPrevented: false,
    preventDefault: () => {}
  }) as unknown as React.KeyboardEvent

beforeEach(() => {
  findingsStore.clearForTests()
  window.argus = { findings: { list: vi.fn(async () => rows()) } } as never
})

describe('useReviewWalk', () => {
  async function setup(): Promise<{
    hook: RenderHookResult<ReturnType<typeof useReviewWalk>, { tree: WalkTree | null }>
    onExpand: Mock
    onAccept: Mock<(id: number) => Promise<FindingRow | null>>
    onReject: Mock
    onReopenStrip: Mock
    onClearStrip: Mock
  }> {
    await findingsStore.load('c1')
    const onExpand = vi.fn()
    const onAccept = vi.fn(async (id: number) => {
      findingsStore.merge('c1', { ...rows().find((f) => f.id === id)!, reviewState: 'accepted' })
      return findingsStore.get('c1').rows.find((f) => f.id === id)!
    })
    const onReject = vi.fn(async () => null)
    const onReopenStrip = vi.fn()
    const onClearStrip = vi.fn()
    const onError = vi.fn()
    const listRef = createRef<HTMLElement | null>()
    const hook = renderHook(
      ({ tree }) =>
        useReviewWalk({
          slug: 'c1',
          tree,
          listRef,
          onExpand,
          onAccept,
          onReject,
          onReopenStrip,
          onClearStrip,
          onError
        }),
      {
        initialProps: {
          tree: buildFindingTree(rows()) as WalkTree | null
        }
      }
    )
    return { hook, onExpand, onAccept, onReject, onReopenStrip, onClearStrip }
  }

  it('starts on the pending cards in tree order, a accepts and advances, s skips, Escape ends', async () => {
    const { hook, onExpand, onAccept } = await setup()
    act(() => hook.result.current.start())
    expect(hook.result.current.walk).toEqual({ ids: [4, 2, 7], i: 0 })
    expect(onExpand).toHaveBeenLastCalledWith(4)
    await act(async () => hook.result.current.onKeyDown(key('a')))
    expect(onAccept).toHaveBeenCalledWith(4)
    expect(hook.result.current.walk?.i).toBe(1)
    act(() => hook.result.current.onKeyDown(key('s')))
    expect(hook.result.current.walk?.i).toBe(2)
    act(() => hook.result.current.onKeyDown(key('Escape')))
    expect(hook.result.current.walk).toBeNull()
    expect(onExpand).toHaveBeenLastCalledWith(null)
  })
  it('a on an already-accepted card only advances; r on a rejected card reopens the strip; k stops at the first', async () => {
    const { hook, onAccept, onReject, onReopenStrip } = await setup()
    act(() => hook.result.current.start())
    findingsStore.merge('c1', { ...rows()[1], reviewState: 'accepted' })
    await act(async () => hook.result.current.onKeyDown(key('a')))
    expect(onAccept).not.toHaveBeenCalled()
    expect(hook.result.current.walk?.i).toBe(1)
    findingsStore.merge('c1', { ...rows()[2], reviewState: 'rejected' })
    act(() => hook.result.current.onKeyDown(key('r')))
    expect(onReject).not.toHaveBeenCalled()
    expect(onReopenStrip).toHaveBeenCalledWith(2)
    act(() => hook.result.current.onKeyDown(key('k')))
    act(() => hook.result.current.onKeyDown(key('k')))
    expect(hook.result.current.walk?.i).toBe(0)
  })
  it('ignores keys from inputs and ends when the tree goes away', async () => {
    const { hook } = await setup()
    act(() => hook.result.current.start())
    act(() => hook.result.current.onKeyDown(key('s', { tagName: 'INPUT' })))
    expect(hook.result.current.walk?.i).toBe(0)
    hook.rerender({ tree: null })
    expect(hook.result.current.walk).toBeNull()
  })
})
