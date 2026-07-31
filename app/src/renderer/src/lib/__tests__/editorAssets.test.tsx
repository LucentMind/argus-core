// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useEditorAssets } from '../editorAssets'

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

  it('drops a response that lands after unmount', async () => {
    const { unmount, result } = renderHook(() => useEditorAssets())
    unmount()
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.rows).toEqual([])
  })
})
