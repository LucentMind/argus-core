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

  it('yields an empty map when the hivemind namespace is missing, without an unhandled rejection', async () => {
    // Checking hiveItems.size === 0 / shareReady === false alone can't distinguish "the
    // degradation path ran and swallowed the failure" from "the effect never ran at all",
    // because both are already true synchronously at mount, before any effect runs. The
    // hook's ONLY observable behavior difference between having and not having
    // `.catch(() => undefined)` on the hivemind chain is whether the rejection from a
    // failing get() is left unhandled — the hook doesn't reset any state on failure — so
    // that's what this test has to catch directly.
    const getSpy = vi.fn().mockRejectedValue(new TypeError('hivemind namespace is missing'))
    ;(
      window as unknown as { argus: { hivemind: { get: typeof getSpy } } }
    ).argus.hivemind.get = getSpy

    const unhandledReasons: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledReasons.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      const { result } = renderHook(() => useSharePush())

      // Proves the hook actually invoked the fetch, instead of the assertions below being
      // trivially satisfied by the pre-effect initial state.
      await waitFor(() => expect(getSpy).toHaveBeenCalled())
      await waitFor(() => expect(result.current.shareReady).toBe(false))
      expect(result.current.hiveItems.size).toBe(0)

      // Flush the microtask queue so a rejection left unhandled by the hook (e.g. if its
      // .catch(() => undefined) were removed) has had a chance to be reported.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandledReasons).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })
})
