import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  indexEvidenceFile,
  indexEvidenceFileAsync,
  deleteEvidenceIndex,
  IndexAbortedError
} from './indexer'
import { setIndexState, listPendingIndexEvidence } from './indexState'
import { caseDir } from './paths'

const ITEM_THROTTLE_MS = 100
const QUEUE_THROTTLE_MS = 250

export interface IngestJob {
  caseSlug: string
  evidenceId: number
  absPath: string
  size: number
  /**
   * Whether phase 1 (FTS indexing) applies to this row.
   *
   * False for a non-indexable artifact — but such a row is still enqueued, because
   * phase 2 (extraction) exists FOR binary artifacts: a pack detector that declares
   * an `extract` command is by definition handling something `isText` says no to.
   * Gating the enqueue on indexability would silently kill derived text for exactly
   * the files it was written for.
   */
  index: boolean
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
  /**
   * Stop indexing this evidence id. Honoured whether the job is queued, in
   * flight, or not yet enqueued — ingest inserts the evidence row before it
   * enqueues, so a delete can legitimately arrive first; the flag is recorded
   * and consumed by the job whenever it turns up. An in-flight job stops at its
   * next chunk boundary and any partial index is removed.
   */
  abort(evidenceId: number): void
}

/**
 * bytesDone/bytesTotal count indexing work only: an index:false job (a binary
 * artifact with nothing to index) never touches either. filesDone/filesTotal
 * count every job, indexable or not -- every job is a real unit of work.
 * A progress-bar consumer should therefore drive off bytes when
 * bytesTotal > 0 and fall back to files otherwise (e.g. an all-binary batch,
 * where bytesTotal stays 0 for the life of the drain).
 */
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
    // Bytes are an indexing metric: indexing time scales with file size, but
    // extraction time is a function of the extractor binary, not the file's
    // size. Counting index:false bytes would let a batch of large non-indexed
    // files (screenshots, binaries) dominate bytesTotal, so the bar jumps to
    // near-100% instantly and then crawls through the one file that actually
    // matters. Files still count every job -- every job is a real unit of work.
    if (job.index) c.bytesTotal += job.size
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

  /** See IngestQueueLike.abort. Recorded unconditionally, including for an id
   *  that has not been enqueued yet; drain() drops the flags once there is
   *  nothing left they could apply to. */
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
        // Mirror the enqueue-side gate: an index:false job never contributed to
        // bytesTotal, so it must not be credited to bytesDone either. Crediting
        // it anyway (while enqueue correctly excludes it) is worse than the bug
        // being fixed: bytesTotal would undercount, so a single completed
        // non-indexed job could push bytesDone to (or past) 100% of a total
        // that the real indexing work hasn't touched yet.
        if (job.index) c.bytesDone = Math.min(c.bytesTotal, baseBytes + job.size)
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
    // Nothing queued and nothing in flight, so no abort flag can still apply to
    // anything. Bounds the Set without narrowing abort(): a flag raised for an
    // id that is never enqueued would otherwise be retained for the life of the
    // process.
    this.aborted.clear()
  }

  private async runJob(job: IngestJob): Promise<void> {
    try {
      await this.runJobInner(job)
    } finally {
      // Single cleanup point for every terminal path through a job — normal
      // completion, error, and all three abort paths — so no abort flag can
      // outlive the job it was raised against, even while other jobs keep the
      // drain alive.
      this.aborted.delete(job.evidenceId)
    }
  }

  private async runJobInner(job: IngestJob): Promise<void> {
    const { db, argusHome } = this.deps
    const { caseSlug: slug, evidenceId } = job

    // Aborted while it was still sitting in the queue: never touched the row.
    if (this.aborted.has(evidenceId)) return

    // Nothing to index (a binary artifact): its index state is already 'skipped' and
    // stays that way. Go straight to extraction, which is the whole reason this row
    // was enqueued at all.
    if (!job.index) {
      await this.runExtraction(job)
      return
    }

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

    await this.runExtraction(job)
  }

  /** Phase 2. Reached by every job that was not aborted, indexable or not. */
  private async runExtraction(job: IngestJob): Promise<void> {
    const { caseSlug: slug, evidenceId } = job
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
 * Re-enqueue every evidence row whose index never finished.
 *
 * Called once at boot. Without it, a crash mid-index leaves that evidence
 * permanently unsearchable with nothing on screen saying so. A row whose file
 * has since vanished is marked 'error' instead of queued — a job that cannot
 * succeed should not sit in the bar's denominator.
 *
 * Every row it returns was left at 'pending'/'indexing', which only an indexable
 * row is ever set to, so each job is enqueued with index: true.
 */
export function requeuePendingIndexes(
  db: DatabaseSync,
  argusHome: string,
  queue: IngestQueueLike
): number {
  let queued = 0
  for (const row of listPendingIndexEvidence(db)) {
    const absPath = path.join(caseDir(argusHome, row.caseSlug), ...row.relPath.split('/'))
    if (!fs.existsSync(absPath)) {
      setIndexState(db, row.id, 'error')
      continue
    }
    // a partial index from the interrupted run would duplicate chunks
    deleteEvidenceIndex(db, row.id)
    queue.enqueue({
      caseSlug: row.caseSlug,
      evidenceId: row.id,
      absPath,
      size: row.size,
      index: true
    })
    queued++
  }
  return queued
}

/**
 * Synchronous stand-in used by tests (and by any caller that genuinely wants
 * ingest-then-immediately-searchable semantics). Indexes inline via the sync
 * indexer and runs no extraction.
 */
export function createImmediateQueue(db: DatabaseSync, argusHome: string): IngestQueueLike {
  return {
    enqueue(job: IngestJob): void {
      // A non-indexable row is enqueued for its extraction only; this stand-in runs
      // none, so there is nothing to do and its 'skipped' state is already correct.
      if (!job.index) return
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
