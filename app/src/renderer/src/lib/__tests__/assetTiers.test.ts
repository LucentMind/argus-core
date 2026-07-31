// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useAssetTiers } from '../assetTiers'

let skillsChanged: ((p: { skills: Array<{ name: string; tier: string }> }) => void) | null = null
let refsChanged: ((p: unknown) => void) | null = null

beforeEach(() => {
  skillsChanged = null
  refsChanged = null
  window.argus = {
    skills: {
      list: vi.fn().mockResolvedValue({
        skills: [
          { name: 'mine', tier: 'user' },
          { name: 'theirs', tier: 'hivemind' }
        ]
      }),
      onChanged: (cb: never) => {
        skillsChanged = cb
        return () => {}
      }
    },
    refsync: {
      get: vi.fn().mockResolvedValue({
        references: [
          { file: 'notes.md', tier: null },
          { file: 'synced.md', tier: 'confluence' }
        ]
      }),
      onChanged: (cb: never) => {
        refsChanged = cb
        return () => {}
      }
    }
  } as never
})

describe('useAssetTiers', () => {
  it('resolves a skill tier', async () => {
    const { result } = renderHook(() => useAssetTiers())
    await waitFor(() => expect(result.current('skill', 'mine')).toBe('user'))
    expect(result.current('skill', 'theirs')).toBe('hivemind')
  })

  it('resolves a reference tier', async () => {
    const { result } = renderHook(() => useAssetTiers())
    await waitFor(() => expect(result.current('reference', 'synced.md')).toBe('confluence'))
  })

  // A reference row with no frontmatter tier is present-and-untagged, which `isAssetEditable`
  // treats as editable. That is NOT the same answer as "no row", so the two must not collapse.
  it('reports null for a present but untagged reference', async () => {
    const { result } = renderHook(() => useAssetTiers())
    await waitFor(() => expect(result.current('reference', 'notes.md')).toBeNull())
  })

  it('reports undefined before the lists have loaded', () => {
    const { result } = renderHook(() => useAssetTiers())
    expect(result.current('skill', 'mine')).toBeUndefined()
  })

  it('reports undefined for an asset in neither list', async () => {
    const { result } = renderHook(() => useAssetTiers())
    await waitFor(() => expect(result.current('skill', 'mine')).toBe('user'))
    expect(result.current('skill', 'nonexistent')).toBeUndefined()
  })

  // The claim/fork paths in Task 8 change a tier, and both broadcast. Without this the tab would
  // stay read-only after the user's own Edit-a-copy succeeded.
  it('picks up a skills broadcast', async () => {
    const { result } = renderHook(() => useAssetTiers())
    await waitFor(() => expect(result.current('skill', 'theirs')).toBe('hivemind'))
    act(() => skillsChanged!({ skills: [{ name: 'theirs', tier: 'user' }] }))
    await waitFor(() => expect(result.current('skill', 'theirs')).toBe('user'))
  })

  // refsync:changed carries no payload the renderer can use — LibraryPage re-fetches on it, and
  // so must this.
  it('re-fetches references on a refsync broadcast', async () => {
    const { result } = renderHook(() => useAssetTiers())
    await waitFor(() => expect(result.current('reference', 'synced.md')).toBe('confluence'))
    window.argus.refsync.get = vi
      .fn()
      .mockResolvedValue({ references: [{ file: 'synced.md', tier: 'user' }] })
    act(() => refsChanged!({}))
    await waitFor(() => expect(result.current('reference', 'synced.md')).toBe('user'))
  })

  it('survives a failing list without throwing', async () => {
    window.argus.skills.list = vi.fn().mockRejectedValue(new Error('nope'))
    const { result } = renderHook(() => useAssetTiers())
    await waitFor(() => expect(result.current('reference', 'synced.md')).toBe('confluence'))
    // Fails open, per deviation 2 — an unresolved tier must never lock the user out.
    expect(result.current('skill', 'mine')).toBeUndefined()
  })
})
