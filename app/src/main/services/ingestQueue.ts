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
  private inFlight: number | null = null
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
    this.kick()
  }

  /**
   * Start a drain unless one is already running, and re-check for work from the
   * settle path.
   *
   * The re-check is not belt-and-braces. drain() returns synchronously in the
   * microtask that resumes it, but `running` is only nulled one microtask later
   * by this `.finally` reaction. A continuation that calls enqueue() in that gap
   * sees `running` still truthy, starts no drain, and the drain it is counting on
   * has already exited — the job is stranded in `jobs` forever with its row stuck
   * at `pending`. Re-kicking here (rather than trusting the latch in enqueue)
   * closes that window; the real `await copy(f); enqueue(...)` ingest loop lands
   * in it. Still strictly serial: only the single live drain can construct
   * another, and `jobs.shift()` is synchronous.
   */
  private kick(): void {
    if (this.running) return
    this.running = this.drain().finally(() => {
      this.running = null
      if (this.jobs.length > 0) this.kick()
    })
  }

  /**
   * Stop indexing this evidence id, whether queued or in flight.
   *
   * Ignored for an id the queue does not know about: the flag is only ever
   * cleared by the job that consumes it, so recording one for a job that will
   * never run would retain it for the life of the process.
   */
  abort(evidenceId: number): void {
    const known = this.inFlight === evidenceId || this.jobs.some((j) => j.evidenceId === evidenceId)
    if (!known) return
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
    // Resolve the counters before touching the throttle: a slug with nothing to
    // report must not consume the window that the next real emit needs.
    const c = this.counters.get(slug)
    if (!c) return
    const t = this.now()
    if (!force && t - this.lastQueueEmit < QUEUE_THROTTLE_MS) return
    this.lastQueueEmit = t
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
    this.inFlight = job.evidenceId
    try {
      await this.runJobInner(job)
    } finally {
      // Single cleanup point for every terminal path through a job — normal
      // completion, error, and all three abort paths — so no abort flag can
      // outlive the job it was raised against.
      this.inFlight = null
      this.aborted.delete(job.evidenceId)
    }
  }

  private async runJobInner(job: IngestJob): Promise<void> {
    const { db, argusHome } = this.deps
    const { caseSlug: slug, evidenceId } = job

    // Aborted while it was still sitting in the queue: never touched the row.
    if (this.aborted.has(evidenceId)) return

    const baseBytes = this.counters.get(slug)?.bytesDone ?? 0
    try {
      setIndexState(db, evidenceId, 'indexing')
      this.emitItem({ slug, evidenceId, phase: 'indexing', fraction: 0 }, true)

      await indexEvidenceFileAsync(db, evidenceId, job.absPath, 400, argusHome, {
        shouldAbort: () => this.aborted.has(evidenceId),
        onProgress: (done) => {
          // Both the per-item fraction and the aggregate counter are sourced from
          // job.size, the same number drain() settles with. The indexer reports
          // against the file's current stat.size; if the file changed on disk
          // since the row was written, mixing the two makes the bar hit 100%
          // mid-job and then fall back.
          const advanced = Math.min(done, job.size)
          const fraction = job.size > 0 ? advanced / job.size : 1
          this.emitItem({ slug, evidenceId, phase: 'indexing', fraction }, false)
          const c = this.counters.get(slug)
          if (c) {
            c.bytesDone = Math.min(c.bytesTotal, baseBytes + advanced)
            this.emitQueue(slug, false)
          }
        }
      })

      // The abort can lose the race with the last chunk: shouldAbort is only
      // consulted at the top of the read loop, so a flag raised after the final
      // read leaves a fully indexed row. Callers abort because the evidence is
      // going away, so undo the index rather than orphan FTS rows against a
      // deleted id, and skip extraction.
      if (this.aborted.has(evidenceId)) {
        deleteEvidenceIndex(db, evidenceId)
        setIndexState(db, evidenceId, 'pending')
        return
      }
      setIndexState(db, evidenceId, 'indexed')
    } catch (err) {
      if (err instanceof IndexAbortedError) {
        // partial chunks would be a phantom index for a row being deleted
        deleteEvidenceIndex(db, evidenceId)
        // back to pending, not stuck at 'indexing' forever (no-ops if the row is gone)
        setIndexState(db, evidenceId, 'pending')
        return
      }
      console.warn(
        `[ingestQueue] indexing failed for evidence ${evidenceId}: ${(err as Error).message}`
      )
      setIndexState(db, evidenceId, 'error')
      this.emitItem({ slug, evidenceId, phase: 'error', fraction: 1 }, true)
      return
    }

    this.emitItem({ slug, evidenceId, phase: 'extracting', fraction: 1 }, true)
    try {
      const derived = await this.deps.extract(evidenceId)
      if (derived) this.deps.onEvidenceChanged(slug)
    } catch (err) {
      console.warn(
        `[ingestQueue] extraction failed for evidence ${evidenceId}: ${(err as Error).message}`
      )
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
    abort(): void {
      // Nothing to cancel: enqueue() finished indexing before it returned, so by
      // the time any caller could abort, the job no longer exists.
    }
  }
}
