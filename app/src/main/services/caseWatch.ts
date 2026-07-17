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

  const teardown = (slug: string): void => {
    watchers.get(slug)?.close()
    watchers.delete(slug)
    const t = timers.get(slug)
    if (t) clearTimeout(t)
    timers.delete(slug)
    suppressUntil.delete(slug)
  }

  // Only user-visible evidence counts as staleness: the case dir also holds
  // session mirrors (250ms flushes), findings.md, case.json and distillation
  // output — none of which the rescan button can reconcile. Dot-segments
  // (.meta/.derived) are pipeline-managed sidecars/derived text, so skipping
  // them also kills self-triggers from our own ingest writes structurally.
  const isRelevant = (filename: string | Buffer | null): boolean => {
    if (!filename || String(filename).length === 0) return true // platform gave no path — be conservative
    const rel = String(filename).replace(/\\/g, '/')
    if (rel !== 'evidence' && !rel.startsWith('evidence/')) return false
    return !rel.split('/').some((seg) => seg.startsWith('.'))
  }

  return {
    watch(slug) {
      if (watchers.has(slug)) return
      assertSlug(slug) // a hostile slug ('..') must not become a recursive watch over argusHome
      const root = caseDir(argusHome, slug)
      try {
        const w = fs.watch(root, { recursive: true }, (_event, filename) => {
          if (!isRelevant(filename)) return
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
          teardown(slug) // full per-slug cleanup: watcher, pending timer, suppression window
        })
        watchers.set(slug, w)
      } catch (err) {
        console.warn(`[files] watch failed for ${slug}: ${(err as Error).message}`)
      }
    },
    unwatch(slug) {
      teardown(slug)
    },
    suppress(slug, ms = 1500) {
      const until = Date.now() + ms
      // monotonic: a later short suppression must not shrink an outstanding longer window
      suppressUntil.set(slug, Math.max(suppressUntil.get(slug) ?? 0, until))
    },
    close() {
      for (const slug of [...watchers.keys()]) this.unwatch(slug)
    }
  }
}
