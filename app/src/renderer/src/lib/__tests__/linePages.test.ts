import { describe, it, expect, vi } from 'vitest'
import { LinePageCache, PAGE_LINES } from '../linePages'

function makeFetcher(): {
  fetcher: (f: number, t: number) => Promise<{ from: number; lines: string[] }>
  calls: Array<[number, number]>
} {
  const calls: Array<[number, number]> = []
  return {
    calls,
    fetcher: async (from, to) => {
      calls.push([from, to])
      return { from, lines: Array.from({ length: to - from + 1 }, (_, i) => `L${from + i}`) }
    }
  }
}

describe('LinePageCache', () => {
  it('getLine returns undefined then the line after the page arrives', async () => {
    const { fetcher } = makeFetcher()
    const cache = new LinePageCache(fetcher)
    const notified = vi.fn()
    cache.subscribe(notified)
    expect(cache.getLine(1500)).toBeUndefined()
    await vi.waitFor(() => expect(notified).toHaveBeenCalled())
    expect(cache.getLine(1500)).toBe('L1500')
  })

  it('one in-flight fetch per page (no duplicate requests)', async () => {
    const { fetcher, calls } = makeFetcher()
    const cache = new LinePageCache(fetcher)
    cache.getLine(10)
    cache.getLine(20)
    cache.getLine(999)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual([[1, PAGE_LINES]])
  })

  it('prefetch spans multiple pages; byte cap evicts oldest pages', async () => {
    const { fetcher, calls } = makeFetcher()
    const cache = new LinePageCache(fetcher, 1) // 1 byte cap → evict immediately
    cache.prefetch(1, PAGE_LINES * 2)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.length).toBe(2)
    // cap of 1 byte: only the most recent page survives at most
    expect(cache.getLine(1)).toBeUndefined()
  })

  it('contains fetch rejections; a later getLine retries the page', async () => {
    let callCount = 0
    const fetcher = (from: number, to: number): Promise<{ from: number; lines: string[] }> => {
      callCount++
      if (callCount === 1) return Promise.reject(new Error('boom'))
      return Promise.resolve({
        from,
        lines: Array.from({ length: to - from + 1 }, (_, i) => `L${from + i}`)
      })
    }
    const cache = new LinePageCache(fetcher)
    const notified = vi.fn()
    cache.subscribe(notified)

    // first attempt rejects: no page arrives, no unhandled rejection escapes
    expect(cache.getLine(5)).toBeUndefined()
    await new Promise((r) => setTimeout(r, 0))
    expect(callCount).toBe(1)
    expect(notified).not.toHaveBeenCalled()

    // rejection settled and inflight cleared → a later getLine retries with a NEW fetch
    expect(cache.getLine(5)).toBeUndefined()
    await vi.waitFor(() => expect(notified).toHaveBeenCalled())
    expect(callCount).toBe(2)
    expect(cache.getLine(5)).toBe('L5')
  })

  it('LRU refresh on read: a recently read page survives eviction', async () => {
    // deterministic sizes: every line exactly 10 chars → one page = 10000 bytes
    const calls: Array<[number, number]> = []
    const fetcher = async (
      from: number,
      to: number
    ): Promise<{ from: number; lines: string[] }> => {
      calls.push([from, to])
      return {
        from,
        lines: Array.from({ length: to - from + 1 }, (_, i) => String(from + i).padStart(10, '0'))
      }
    }
    // room for two pages plus slack, so loading a third forces exactly one eviction
    const cache = new LinePageCache(fetcher, 2 * PAGE_LINES * 10 + 100)
    const notified = vi.fn()
    cache.subscribe(notified)

    cache.getLine(1) // load page 0
    cache.getLine(PAGE_LINES + 1) // load page 1
    await vi.waitFor(() => expect(notified).toHaveBeenCalledTimes(2))

    // read from page 0 → promotes it above page 1 in LRU order
    expect(cache.getLine(1)).toBe('1'.padStart(10, '0'))

    cache.getLine(2 * PAGE_LINES + 1) // load page 2 → must evict page 1, not page 0
    await vi.waitFor(() => expect(notified).toHaveBeenCalledTimes(3))

    const callsBefore = calls.length
    expect(cache.getLine(1)).toBe('1'.padStart(10, '0')) // page 0 survived
    expect(calls.length).toBe(callsBefore) // …and answered from cache
    expect(cache.getLine(PAGE_LINES + 1)).toBeUndefined() // page 1 evicted
    expect(calls.length).toBe(callsBefore + 1) // …and triggers a refetch
  })

  it('getLine with n < 1 returns undefined without fetching', () => {
    const { fetcher, calls } = makeFetcher()
    const cache = new LinePageCache(fetcher)
    expect(cache.getLine(0)).toBeUndefined()
    expect(cache.getLine(-5)).toBeUndefined()
    expect(calls.length).toBe(0)
  })
})
