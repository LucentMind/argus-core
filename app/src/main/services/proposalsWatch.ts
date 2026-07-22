// Watches the proposals dir so proposal files dropped in externally (manual
// seeding, external tools) also go live — the in-process notifier in
// proposals.ts only fires for writes routed through this app. Modeled closely
// on caseWatch.ts: same debounce + async-'error' crash guard + teardown
// discipline, but there's only one directory here, so no per-slug maps.
import fs from 'node:fs'
import { proposalsDir } from './paths'

const DEBOUNCE_MS = 300

export interface ProposalsWatch {
  close(): void
}

export function createProposalsWatch(argusHome: string, onChanged: () => void): ProposalsWatch {
  const dir = proposalsDir(argusHome)
  // dir may not exist yet at boot (first launch, or before any proposal has been written)
  fs.mkdirSync(dir, { recursive: true })

  let timer: NodeJS.Timeout | undefined
  let watcher: fs.FSWatcher | undefined

  const teardown = (): void => {
    watcher?.close()
    watcher = undefined
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  try {
    watcher = fs.watch(dir, (_event, filename) => {
      // filename is null on some platforms/events — treat that as relevant (be
      // conservative, matching caseWatch). Otherwise only .md files matter; a
      // non-recursive watch shouldn't emit events for the archive/ subdir, but
      // ignore a bare 'archive' filename defensively in case one surfaces.
      if (filename != null) {
        const name = String(filename)
        if (name === 'archive') return
        if (!name.endsWith('.md')) return
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        onChanged()
      }, DEBOUNCE_MS)
    })
    // fs.watch's try/catch only covers sync setup; on Windows, deleting the
    // watched dir out from under the watcher emits an async 'error' event —
    // unhandled, that crashes the main process.
    watcher.on('error', (err) => {
      console.warn(`[proposals] watcher error: ${(err as Error).message}`)
      teardown()
    })
  } catch (err) {
    console.warn(`[proposals] watch failed: ${(err as Error).message}`)
  }

  return {
    close() {
      teardown()
    }
  }
}
