export const PAGE_LINES = 1000
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

interface Page {
  lines: string[]
  bytes: number
}

/** LRU page cache over textdoc.lines. Pages are PAGE_LINES-aligned; byte-capped
 *  so pathological line lengths can't balloon renderer memory. */
export class LinePageCache {
  private pages = new Map<number, Page>() // pageNo → page (Map order = LRU)
  private inflight = new Set<number>()
  private subs = new Set<() => void>()
  private totalBytes = 0
  private disposed = false

  constructor(
    private fetcher: (from: number, to: number) => Promise<{ from: number; lines: string[] }>,
    private maxBytes = DEFAULT_MAX_BYTES
  ) {}

  getLine(n: number): string | undefined {
    const pageNo = Math.floor((n - 1) / PAGE_LINES)
    const page = this.pages.get(pageNo)
    if (page) {
      // refresh LRU position
      this.pages.delete(pageNo)
      this.pages.set(pageNo, page)
      return page.lines[(n - 1) % PAGE_LINES]
    }
    this.requestPage(pageNo)
    return undefined
  }

  prefetch(fromLine: number, toLine: number): void {
    const first = Math.floor((Math.max(1, fromLine) - 1) / PAGE_LINES)
    const last = Math.floor((Math.max(1, toLine) - 1) / PAGE_LINES)
    for (let p = first; p <= last; p++) if (!this.pages.has(p)) this.requestPage(p)
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb)
    return () => this.subs.delete(cb)
  }

  dispose(): void {
    this.disposed = true
    this.subs.clear()
    this.pages.clear()
    this.inflight.clear()
  }

  private requestPage(pageNo: number): void {
    if (this.inflight.has(pageNo) || this.disposed) return
    this.inflight.add(pageNo)
    const from = pageNo * PAGE_LINES + 1
    void this.fetcher(from, from + PAGE_LINES - 1)
      .then((r) => {
        if (this.disposed) return
        const bytes = r.lines.reduce((a, l) => a + l.length, 0)
        this.pages.set(pageNo, { lines: r.lines, bytes })
        this.totalBytes += bytes
        while (this.totalBytes > this.maxBytes && this.pages.size > 1) {
          const oldest = this.pages.keys().next().value as number
          this.totalBytes -= this.pages.get(oldest)?.bytes ?? 0
          this.pages.delete(oldest)
        }
        this.subs.forEach((cb) => cb())
      })
      .finally(() => this.inflight.delete(pageNo))
  }
}
