import type { DatabaseSync } from 'node:sqlite'
import { textDocKey, type TextDocSearchEvent, type TextDocSource } from '../../shared/textdoc'
import { ensureIndex, searchLines } from './lineIndex'
import { resolveTextDocAbs } from './textdoc'

export interface TextDocSearchOpts {
  regex?: boolean
  caseSensitive?: boolean
  fromLine?: number
  toLine?: number
  filter?: { query: string; regex?: boolean; caseSensitive?: boolean }
}

/** One live search per hub start(); starting a new id aborts the old one.
 *  Events go out through the injected send — electron-free, DI-testable. */
export class TextDocSearchHub {
  private active = new Map<string, AbortController>()

  constructor(
    private db: DatabaseSync,
    private argusHome: string,
    private send: (payload: TextDocSearchEvent) => void,
    /** Optional index-build progress sink (same payload shape as textdoc:index-progress):
     *  a search on a stale/unindexed file triggers a lazy rebuild, and without this the
     *  renderer would see a silent multi-second stall instead of the indexing chip. */
    private sendProgress?: (p: { key: string; fraction: number }) => void
  ) {}

  async start(
    searchId: string,
    source: TextDocSource,
    query: string,
    opts: TextDocSearchOpts
  ): Promise<void> {
    // supersede only the previous search on the same channel — ids are
    // `<docKey>:<channel>:<seq>`, so the prefix up to the last ':' names the channel
    const prefix = searchId.slice(0, searchId.lastIndexOf(':') + 1)
    for (const [id, prior] of this.active) {
      if (id.startsWith(prefix)) {
        prior.abort()
        this.active.delete(id)
      }
    }
    const ac = new AbortController()
    this.active.set(searchId, ac)
    try {
      const res = resolveTextDocAbs(this.db, this.argusHome, source)
      if ('error' in res) {
        this.send({ searchId, hits: [], scannedTo: 0, done: true, capped: false })
        return
      }
      const index = await ensureIndex(this.argusHome, res.abs, (fraction) =>
        this.sendProgress?.({ key: textDocKey(source), fraction })
      )
      for await (const batch of searchLines(index, res.abs, query, {
        ...opts,
        signal: ac.signal
      })) {
        if (ac.signal.aborted) return
        this.send({ searchId, ...batch })
      }
    } catch {
      // invalid regex or IO error — report a terminal empty event so the UI settles
      if (!ac.signal.aborted)
        this.send({ searchId, hits: [], scannedTo: 0, done: true, capped: false })
    } finally {
      if (this.active.get(searchId) === ac) this.active.delete(searchId)
    }
  }

  cancel(searchId: string): void {
    this.active.get(searchId)?.abort()
    this.active.delete(searchId)
  }

  cancelAll(): void {
    for (const ac of this.active.values()) ac.abort()
    this.active.clear()
  }
}
