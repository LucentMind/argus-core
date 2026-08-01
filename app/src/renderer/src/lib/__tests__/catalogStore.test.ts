// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
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
    catalog.mockRejectedValueOnce(new Error('nope'))
    const { result } = renderHook(() => useModelCatalog('claude-default'))
    await waitFor(() => expect(result.current).toEqual([]))
  })
})
