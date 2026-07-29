// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useSharePush } from '../useSharePush'

const item = {
  kind: 'reference' as const,
  name: 'adasis.md',
  description: '',
  commit: 'abc',
  installed: true,
  installedCommit: 'abc',
  localTier: 'hivemind',
  updateAvailable: true
}

beforeEach(() => {
  ;(window as unknown as { argus: unknown }).argus = {
    hivemind: {
      get: vi.fn().mockResolvedValue({
        repo: 'acme/hivemind',
        state: 'ready',
        error: null,
        headCommit: null,
        lastSynced: null,
        items: [item, { ...item, kind: 'skill', name: 'rca', updateAvailable: false }],
        pushable: [],
        pushes: {}
      })
    },
    sourceControl: {
      status: vi.fn().mockResolvedValue({
        installed: true,
        version: '2.62',
        authenticated: true,
        login: 'me',
        detail: ''
      })
    }
  }
})

describe('useSharePush', () => {
  it('keys hive items by kind/name', async () => {
    const { result } = renderHook(() => useSharePush())
    await waitFor(() => expect(result.current.hiveItems.size).toBe(2))
    expect(result.current.hiveItems.get('reference/adasis.md')?.updateAvailable).toBe(true)
    expect(result.current.hiveItems.get('skill/rca')?.updateAvailable).toBe(false)
  })

  it('yields an empty map when the hivemind namespace is missing', async () => {
    ;(window as unknown as { argus: { hivemind?: unknown } }).argus.hivemind = undefined
    const { result } = renderHook(() => useSharePush())
    await waitFor(() => expect(result.current.shareReady).toBe(false))
    expect(result.current.hiveItems.size).toBe(0)
  })
})
