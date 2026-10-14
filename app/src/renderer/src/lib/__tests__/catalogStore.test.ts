// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useModelCatalog, clearCatalogStore, refreshModelCatalog } from '../catalogStore'

const onChangedMock = vi.fn<(cb: () => void) => () => void>(() => () => {})
const catalog = vi.fn(async () => [
  { value: 'fable', displayName: 'Fable', supportsEffort: true, supportedEffortLevels: ['high'] }
])

beforeEach(() => {
  clearCatalogStore()
  catalog.mockClear()
  ;(globalThis as unknown as { window: { argus: unknown } }).window.argus = {
    models: { catalog, refresh: catalog, onChanged: onChangedMock }
  }
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

describe('catalog invalidation', () => {
  it('refreshModelCatalog refetches through main and re-renders mounted hooks', async () => {
    const { result } = renderHook(() => useModelCatalog('claude-default'))
    await waitFor(() => expect(result.current).toHaveLength(1))
    catalog.mockResolvedValueOnce([
      { value: 'sonnet', displayName: 'Sonnet 5.5' },
      { value: 'haiku', displayName: 'Haiku 5.5' }
    ] as never)
    await act(async () => {
      await refreshModelCatalog('claude-default')
    })
    expect(result.current).toHaveLength(2)
  })

  it('refetches when main reports the account changed', async () => {
    let fire: () => void = () => undefined
    onChangedMock.mockImplementation((cb: () => void) => {
      fire = cb
      return () => undefined
    })
    const { result } = renderHook(() => useModelCatalog('claude-default'))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(catalog).toHaveBeenCalledTimes(1)
    catalog.mockResolvedValueOnce([
      { value: 'a', displayName: 'A' },
      { value: 'b', displayName: 'B' },
      { value: 'c', displayName: 'C' }
    ] as never)
    act(() => fire())
    await waitFor(() => expect(result.current).toHaveLength(3))
    expect(catalog).toHaveBeenCalledTimes(2)
  })

  it('unsubscribes from main on unmount', () => {
    const off = vi.fn()
    onChangedMock.mockImplementation(() => off)
    const { unmount } = renderHook(() => useModelCatalog('claude-default'))
    unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('expires a successful fetch after an hour', async () => {
    vi.useFakeTimers()
    const flush = (ms: number): Promise<void> =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
    try {
      const first = renderHook(() => useModelCatalog('claude-default'))
      await flush(0)
      expect(first.result.current).toHaveLength(1)
      first.unmount()
      await flush(59 * 60 * 1000)
      renderHook(() => useModelCatalog('claude-default')).unmount()
      expect(catalog).toHaveBeenCalledTimes(1)
      await flush(2 * 60 * 1000)
      renderHook(() => useModelCatalog('claude-default'))
      await flush(0)
      expect(catalog).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
