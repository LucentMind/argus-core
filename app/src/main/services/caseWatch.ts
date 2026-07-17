// Per-case fs.watch hub (spec §3): watches case dirs and reports changes so the
// renderer can show a staleness hint. suppress() swallows self-caused events
// (scans and in-app ingestion write sidecars/derived files inside the tree).
import fs from 'node:fs'
import { caseDir } from './paths'
import { assertSlug } from './caseFiles'

const DEBOUNCE_MS = 300

export interface CaseWatchHub {
  watch(slug: string): void
  unwatch(slug: string): void
  /** Swallow change events for slug until `ms` from now (default covers debounce + writes). */
  suppress(slug: string, ms?: number): void
  close(): void
}

export function createCaseWatchHub(
  argusHome: string,
  onChanged: (slug: string) => void
): CaseWatchHub {
  const watchers = new Map<string, fs.FSWatcher>()
  const timers = new Map<string, NodeJS.Timeout>()
  const suppressUntil = new Map<string, number>()

  return {
    watch(slug) {
      if (watchers.has(slug)) return
      assertSlug(slug) // a hostile slug ('..') must not become a recursive watch over argusHome
      const root = caseDir(argusHome, slug)
      try {
        const w = fs.watch(root, { recursive: true }, () => {
          const t = timers.get(slug)
          if (t) clearTimeout(t)
          timers.set(
            slug,
            setTimeout(() => {
              // checked at fire time so a suppress() during the debounce still wins
              if (Date.now() < (suppressUntil.get(slug) ?? 0)) return
              onChanged(slug)
            }, DEBOUNCE_MS)
          )
        })
        // fs.watch's try/catch only covers sync setup; on Windows, deleting the
        // watched dir out from under the watcher emits an async 'error' event —
        // unhandled, that crashes the main process.
        w.on('error', (err) => {
          console.warn(`[files] watcher error for ${slug}: ${(err as Error).message}`)
          w.close()
          watchers.delete(slug)
        })
        watchers.set(slug, w)
      } catch (err) {
        console.warn(`[files] watch failed for ${slug}: ${(err as Error).message}`)
      }
    },
    unwatch(slug) {
      watchers.get(slug)?.close()
      watchers.delete(slug)
      const t = timers.get(slug)
      if (t) clearTimeout(t)
      timers.delete(slug)
    },
    suppress(slug, ms = 1500) {
      suppressUntil.set(slug, Date.now() + ms)
    },
    close() {
      for (const slug of [...watchers.keys()]) this.unwatch(slug)
    }
  }
}
