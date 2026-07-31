// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useEditorAssets } from '../editorAssets'
import type { CorpusItem } from '../../../../shared/corpusSearch'
import type { DraftRecord } from '../../../../shared/editorIpc'

/** Resolved by hand, on whatever schedule the test chooses — the clearest way to make one IPC
 *  call land before another regardless of the order they were issued in. */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

let onSkills: ((p: unknown) => void) | null = null

beforeEach(() => {
  onSkills = null
  ;(window as unknown as { argus: unknown }).argus = {
    editor: {
      corpus: vi
        .fn()
        .mockResolvedValue([
          { kind: 'skill', name: 'triage', title: '', description: 'd', tier: 'user' }
        ]),
      listDrafts: vi.fn().mockResolvedValue([
        {
          kind: 'skill',
          name: 'half',
          mode: 'create',
          content: '',
          baseHash: null,
          updatedAt: '2026-07-30T10:00:00.000Z',
          draftId: 'd1'
        }
      ])
    },
    skills: {
      onChanged: (cb: (p: unknown) => void) => {
        onSkills = cb
        return () => {
          onSkills = null
        }
      }
    },
    refsync: { onChanged: () => () => {} }
  }
})

describe('useEditorAssets', () => {
  it('merges the corpus and the orphan drafts, drafts last', async () => {
    const { result } = renderHook(() => useEditorAssets())
    await waitFor(() => expect(result.current.rows).toHaveLength(2))
    expect(result.current.rows.map((r) => r.kind)).toEqual(['skill', 'draft'])
  })

  it('re-reads on refresh', async () => {
    const { result } = renderHook(() => useEditorAssets())
    await waitFor(() => expect(result.current.rows).toHaveLength(2))
    act(() => result.current.refresh())
    await waitFor(() => expect(window.argus.editor.corpus).toHaveBeenCalledTimes(2))
  })

  it('re-reads when a fork or a claim changes the skill list', async () => {
    const { result } = renderHook(() => useEditorAssets())
    await waitFor(() => expect(result.current.rows).toHaveLength(2))
    act(() => onSkills!({ skills: [] }))
    await waitFor(() => expect(window.argus.editor.corpus).toHaveBeenCalledTimes(2))
  })

  it('keeps a stable refresh identity, so a consumer memo does not churn', async () => {
    const { result, rerender } = renderHook(() => useEditorAssets())
    await waitFor(() => expect(result.current.rows).toHaveLength(2))
    const first = result.current.refresh
    rerender()
    expect(result.current.refresh).toBe(first)
  })

  it('survives an IPC failure with an empty list rather than an unhandled rejection', async () => {
    ;(window.argus.editor.corpus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('nope'))
    const { result } = renderHook(() => useEditorAssets())
    await waitFor(() => expect(window.argus.editor.corpus).toHaveBeenCalled())
    expect(result.current.rows).toEqual([])
  })

  it('applies only the newest refresh when an older response lands after it', async (): Promise<void> => {
    const corpusFn = window.argus.editor.corpus as ReturnType<typeof vi.fn>
    const draftsFn = window.argus.editor.listDrafts as ReturnType<typeof vi.fn>

    // Call 1 is the automatic refresh() the mount effect fires; call 2 is the one this test
    // issues by hand. Both are put on hold, then resolved out of issue order — call 2 first,
    // call 1 (stale) after — which is exactly what a `skills:changed` burst during a slow read
    // can do in the real app.
    const call1 = {
      corpus: createDeferred<CorpusItem[]>(),
      drafts: createDeferred<DraftRecord[]>()
    }
    const call2 = {
      corpus: createDeferred<CorpusItem[]>(),
      drafts: createDeferred<DraftRecord[]>()
    }

    corpusFn.mockReset()
    corpusFn.mockImplementationOnce(() => call1.corpus.promise)
    corpusFn.mockImplementationOnce(() => call2.corpus.promise)
    draftsFn.mockReset()
    draftsFn.mockImplementationOnce(() => call1.drafts.promise)
    draftsFn.mockImplementationOnce(() => call2.drafts.promise)

    const { result } = renderHook(() => useEditorAssets())
    expect(corpusFn).toHaveBeenCalledTimes(1)

    act(() => result.current.refresh())
    expect(corpusFn).toHaveBeenCalledTimes(2)

    // The newer call resolves first, with its own dataset.
    call2.corpus.resolve([
      { kind: 'skill', name: 'newer', title: '', description: '', tier: 'user' }
    ])
    call2.drafts.resolve([])
    await waitFor(() => expect(result.current.rows.map((r) => r.name)).toEqual(['newer']))

    // The stale call resolves after, with a different dataset. Without the `runId.current !==
    // my` guard in `refresh`, this overwrites `rows` with the older data purely because it
    // happened to land last in wall-clock time, even though it was issued first. Wrapped in
    // `act` (rather than a bare timer flush) so that if the guard is gone and React schedules a
    // real update, it is guaranteed to be committed to `result.current` by the time this resolves
    // — otherwise a slow-to-flush update could make this assertion pass by accident.
    await act(async () => {
      call1.corpus.resolve([
        { kind: 'skill', name: 'older', title: '', description: '', tier: 'user' }
      ])
      call1.drafts.resolve([])
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(result.current.rows.map((r) => r.name)).toEqual(['newer'])
  })

  // The other half of the same guard — dropping a response that lands after unmount — has no
  // test here. `renderHook`'s `result.current` is only ever written as a side effect of the
  // hook's own render, and after `unmount()` no render can occur, so a late `setRows(...)` is a
  // no-op against `result.current` whether or not `live.current` is checked; that was the
  // original defect (the deleted test asserted exactly this tautology). Checked empirically
  // (temporarily removing the `live.current` check and probing with a `console.error` spy)
  // that calling `setRows` after `unmount()` produces no observable signal either way in this
  // React/RTL setup: React tears the fiber down on unmount without warning, so there's nothing
  // to assert on from outside. Pinning this half would require an observable inside
  // `editorAssets.ts` itself (e.g. counting the call), which is out of scope here since the
  // production code must not change.
})
