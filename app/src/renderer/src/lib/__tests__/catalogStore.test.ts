// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useModelCatalog, clearCatalogStore } from '../catalogStore'

const catalog = vi.fn(async () => [
  { value: 'fable', displayName: 'Fable', supportsEffort: true, supportedEffortLevels: ['high'] }
])

beforeEach(() => {
  clearCatalogStore()
  catalog.mockClear()
  ;(globalThis as unknown as { window: { argus: unknown } }).window.argus = { models: { catalog } }
})

describe('useModelCatalog', () => {
  it('starts empty and fills once the catalog arrives', async () => {
    const { result } = renderHook(() => useModelCatalog('claude-default'))
    expect(result.current).toEqual([])
    await waitFor(() => expect(result.current).toHaveLength(1))
  })

  it('fetches once per instance even across several mounts', async () => {
    renderHook(() => useModelCatalog('claude-default'))
    renderHook(() => useModelCatalog('claude-default'))
    await waitFor(() => expect(catalog).toHaveBeenCalledTimes(1))
  })

  it('stays empty for a null instance rather than fetching', () => {
    const { result } = renderHook(() => useModelCatalog(null))
    expect(result.current).toEqual([])
    expect(catalog).not.toHaveBeenCalled()
  })

  it('stays empty when the fetch rejects, so the composer still renders', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      catalog.mockRejectedValueOnce(new Error('nope'))
      const { result } = renderHook(() => useModelCatalog('claude-default'))
      await waitFor(() => expect(result.current).toEqual([]))
    } finally {
      warn.mockRestore()
    }
  })

  // Mirrors the main-process side (drivers/claude/catalog.ts's FAILURE_TTL_MS). Without the
  // eviction, one failed fetch pinned an empty options menu for this instance for the whole
  // renderer process lifetime — no reload, no restart, no log — even after main had healed.
  it('evicts a failed entry after 60s so it retries, and warns exactly once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.useFakeTimers()
    try {
      catalog.mockRejectedValueOnce(new Error('nope'))
      renderHook(() => useModelCatalog('claude-default'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(catalog).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledTimes(1)

      // still inside the TTL: the failure is shared, not re-fetched
      renderHook(() => useModelCatalog('claude-default'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(catalog).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      const { result } = renderHook(() => useModelCatalog('claude-default'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(catalog).toHaveBeenCalledTimes(2)
      expect(result.current).toHaveLength(1)
      // the retry succeeded, so nothing new to warn about
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
    }
  })
})
