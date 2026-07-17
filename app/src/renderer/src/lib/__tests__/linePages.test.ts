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
})
