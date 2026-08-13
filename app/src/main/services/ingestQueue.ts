import fs from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import {
  indexEvidenceFile,
  indexEvidenceFileAsync,
  deleteEvidenceIndex,
  IndexAbortedError
} from './indexer'
import { setIndexState } from './indexState'

const ITEM_THROTTLE_MS = 100
const QUEUE_THROTTLE_MS = 250

export interface IngestJob {
  caseSlug: string
  evidenceId: number
  absPath: string
  size: number
}

export type EvidencePhase = 'indexing' | 'extracting' | 'done' | 'error'

export interface EvidenceProgressEvent {
  slug: string
  evidenceId: number
  phase: EvidencePhase
  fraction: number
}

export interface QueueProgressEvent {
  slug: string
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
}

export interface IngestQueueDeps {
  db: DatabaseSync
  argusHome: string
  /** Runs the pack-declared extractor. Resolves true when a derived record was created. */
  extract: (evidenceId: number) => Promise<boolean>
  onItemProgress: (e: EvidenceProgressEvent) => void
  onQueueProgress: (e: QueueProgressEvent) => void
  onEvidenceChanged: (caseSlug: string) => void
  /** Injected for throttle tests. Defaults to Date.now. */
  now?: () => number
}

/** The seam ingest.ts depends on, so tests can pass a synchronous double. */
export interface IngestQueueLike {
  enqueue(job: IngestJob): void
  abort(evidenceId: number): void
}

interface CaseCounters {
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
}

/**
 * Serial background queue for phase 2 of ingest: FTS indexing, then extraction.
 *
 * Serial on purpose. The work is disk-bound against a single SQLite writer, so
 * running jobs concurrently would thrash rather than help, and would make the
 * aggregate progress bar jump around instead of advancing.
 *
 * Electron-free by construction — it takes its emitters as callbacks — so it is
 * testable in a plain Vitest process.
 */
export class IngestQueue implements IngestQueueLike {
  private readonly jobs: IngestJob[] = []
  private readonly aborted = new Set<number>()
  private readonly counters = new Map<string, CaseCounters>()
  private running: Promise<void> | null = null
  private lastItemEmit = 0
  private lastQueueEmit = 0
  private readonly now: () => number

  constructor(private readonly deps: IngestQueueDeps) {
    this.now = deps.now ?? Date.now
  }

  enqueue(job: IngestJob): void {
    this.jobs.push(job)
    const c = this.counters.get(job.caseSlug) ?? {
      filesDone: 0,
      filesTotal: 0,
      bytesDone: 0,
      bytesTotal: 0
    }
    c.filesTotal++
    c.bytesTotal += job.size
    this.counters.set(job.caseSlug, c)
    this.emitQueue(job.caseSlug, true)
    if (!this.running) this.running = this.drain().finally(() => (this.running = null))
  }

  /** Stop indexing this evidence id, whether queued or in flight. */
  abort(evidenceId: number): void {
    this.aborted.add(evidenceId)
  }

  /** Resolves once the queue is empty. Test affordance; production never awaits it. */
  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  private emitItem(e: EvidenceProgressEvent, force: boolean): void {
    const t = this.now()
    if (!force && t - this.lastItemEmit < ITEM_THROTTLE_MS) return
    this.lastItemEmit = t
    this.deps.onItemProgress(e)
  }

  private emitQueue(slug: string, force: boolean): void {
    const t = this.now()
    if (!force && t - this.lastQueueEmit < QUEUE_THROTTLE_MS) return
    this.lastQueueEmit = t
    const c = this.counters.get(slug)
    if (!c) return
    this.deps.onQueueProgress({ slug, ...c })
  }

  private async drain(): Promise<void> {
    while (this.jobs.length > 0) {
      const job = this.jobs.shift() as IngestJob
      // Snapshot bytesDone before the job runs: onProgress inside runJob already
      // advances the live counter up to this baseline + job.size on a normal
      // completion, so finishing the job here must SET (not add to) that same
      // total — adding again would double-count every successfully indexed file.
      const baseBytes = this.counters.get(job.caseSlug)?.bytesDone ?? 0
      await this.runJob(job)
      const c = this.counters.get(job.caseSlug)
      if (c) {
        c.filesDone++
        c.bytesDone = Math.min(c.bytesTotal, baseBytes + job.size)
        // Nothing left for this case: zero the counters and emit once more so the
        // renderer's bar hides instead of freezing at 100%.
        const others = this.jobs.some((j) => j.caseSlug === job.caseSlug)
        if (!others) {
          this.counters.set(job.caseSlug, {
            filesDone: 0,
            filesTotal: 0,
            bytesDone: 0,
            bytesTotal: 0
          })
        }
        this.emitQueue(job.caseSlug, true)
      }
    }
  }

  private async runJob(job: IngestJob): Promise<void> {
    const { db, argusHome } = this.deps
    const { caseSlug: slug, evidenceId } = job

    if (this.aborted.has(evidenceId)) {
      this.aborted.delete(evidenceId)
      return
    }

    const baseBytes = this.counters.get(slug)?.bytesDone ?? 0
    try {
      setIndexState(db, evidenceId, 'indexing')
      this.emitItem({ slug, evidenceId, phase: 'indexing', fraction: 0 }, true)

      await indexEvidenceFileAsync(db, evidenceId, job.absPath, 400, argusHome, {
        shouldAbort: () => this.aborted.has(evidenceId),
        onProgress: (done, total) => {
          const fraction = total > 0 ? done / total : 1
          this.emitItem({ slug, evidenceId, phase: 'indexing', fraction }, false)
          const c = this.counters.get(slug)
          if (c) {
            c.bytesDone = Math.min(c.bytesTotal, baseBytes + done)
            this.emitQueue(slug, false)
          }
        }
      })
      setIndexState(db, evidenceId, 'indexed')
    } catch (err) {
      if (err instanceof IndexAbortedError) {
        // partial chunks would be a phantom index for a row being deleted
        deleteEvidenceIndex(db, evidenceId)
        this.aborted.delete(evidenceId)
        return
      }
      console.warn(`[ingestQueue] indexing failed for evidence ${evidenceId}: ${(err as Error).message}`)
      setIndexState(db, evidenceId, 'error')
      this.emitItem({ slug, evidenceId, phase: 'error', fraction: 1 }, true)
      return
    }

    this.emitItem({ slug, evidenceId, phase: 'extracting', fraction: 1 }, true)
    try {
      const derived = await this.deps.extract(evidenceId)
      if (derived) this.deps.onEvidenceChanged(slug)
    } catch (err) {
      console.warn(`[ingestQueue] extraction failed for evidence ${evidenceId}: ${(err as Error).message}`)
    }
    this.emitItem({ slug, evidenceId, phase: 'done', fraction: 1 }, true)
  }
}

/**
 * Synchronous stand-in used by tests (and by any caller that genuinely wants
 * ingest-then-immediately-searchable semantics). Indexes inline via the sync
 * indexer and runs no extraction.
 */
export function createImmediateQueue(db: DatabaseSync, argusHome: string): IngestQueueLike {
  return {
    enqueue(job: IngestJob): void {
      if (!fs.existsSync(job.absPath)) return
      indexEvidenceFile(db, job.evidenceId, job.absPath, 400, argusHome)
      setIndexState(db, job.evidenceId, 'indexed')
    },
    abort(): void {}
  }
}
