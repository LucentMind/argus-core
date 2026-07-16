import type { DatabaseSync } from 'node:sqlite'
import type {
  CaseDistillInput,
  CaseDistillOutput,
  DistillJobRow,
  DistillStatusPayload
} from '../../../shared/distill'
import type { CaseDistillRun } from './caseDistiller'
import type { StageResult } from './staging'
import { DistillParseError } from './contract'

export interface DistillQueueDeps {
  db: DatabaseSync
  /** Throws → caller sees the throw; nothing is enqueued (guarded by callers). */
  assembleInput: (slug: string) => CaseDistillInput
  distill: (input: CaseDistillInput) => Promise<CaseDistillRun>
  stage: (caseSlug: string, jobId: number, output: CaseDistillOutput) => StageResult
  broadcast: (payload: DistillStatusPayload) => void
}

interface JobDbRow {
  id: number
  case_slug: string
  state: string
  input_snapshot: string
  raw_output: string | null
  error: string | null
  item_count: number | null
  created_at: string
  finished_at: string | null
}

function toRow(r: JobDbRow): DistillJobRow {
  return {
    id: r.id,
    caseSlug: r.case_slug,
    state: r.state as DistillJobRow['state'],
    error: r.error,
    itemCount: r.item_count,
    createdAt: r.created_at,
    finishedAt: r.finished_at
  }
}

/**
 * Single in-flight FIFO runner over the `distill_jobs` table.
 *
 * `kick()` fires a void async loop that processes queued jobs one at a time in id
 * order; every state transition (running/done/failed) is persisted then broadcast.
 * `idle()` is a test helper only — it must consult BOTH the `running` flag and
 * `nextQueued()` because `nextQueued()`'s `WHERE state='queued'` clause excludes a
 * job that is currently mid-flight (state='running'); checking the DB alone would
 * report "idle" while a job is actively running. Every `running`/DB-state read used
 * by `idle()` happens on the same synchronous call stack as the code that mutates
 * it (enqueue/retry set `running=true` synchronously inside `kick()`, before any
 * `await`; the loop's terminal `nextQueued()` check and the `finally` block's
 * `running=false` + waiter resolution run back-to-back with no intervening
 * `await`), so there is no window where external synchronous code could observe a
 * torn state — Node's single-threaded, run-to-completion execution combined with
 * the synchronous `node:sqlite` driver rules that out.
 */
export class DistillQueue {
  private running = false
  private waiters: (() => void)[] = []

  constructor(private deps: DistillQueueDeps) {}

  /** running → failed('app quit mid-distill'); returns count of rows flipped. */
  recoverOnBoot(): number {
    const res = this.deps.db
      .prepare(
        `UPDATE distill_jobs SET state='failed', error='app quit mid-distill', finished_at=? WHERE state='running'`
      )
      .run(new Date().toISOString())
    return Number(res.changes)
  }

  /** Snapshots `assembleInput(slug)` NOW; throws only on snapshot failure (callers guard it). */
  enqueue(slug: string): DistillJobRow {
    const snapshot = JSON.stringify(this.deps.assembleInput(slug))
    const res = this.deps.db
      .prepare(
        `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at) VALUES (?, 'queued', ?, ?)`
      )
      .run(slug, snapshot, new Date().toISOString())
    const job = this.get(Number(res.lastInsertRowid))!
    this.emit(job)
    this.kick()
    return job
  }

  /** failed → queued, reusing the original snapshot. Throws if the job isn't failed. */
  retry(jobId: number): DistillJobRow {
    const job = this.get(jobId)
    if (!job || job.state !== 'failed') throw new Error(`distill job ${jobId} is not failed`)
    this.deps.db
      .prepare(
        `UPDATE distill_jobs SET state='queued', error=NULL, raw_output=NULL, item_count=NULL, finished_at=NULL WHERE id=?`
      )
      .run(jobId)
    const fresh = this.get(jobId)!
    this.emit(fresh)
    this.kick()
    return fresh
  }

  /** Latest job (highest id) for slug, or null. */
  statusFor(slug: string): DistillJobRow | null {
    const r = this.deps.db
      .prepare(`SELECT * FROM distill_jobs WHERE case_slug = ? ORDER BY id DESC LIMIT 1`)
      .get(slug) as JobDbRow | undefined
    return r ? toRow(r) : null
  }

  /** Test helper: resolves once nothing is queued or running. See class docs for race analysis. */
  idle(): Promise<void> {
    if (!this.running && !this.nextQueued()) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private get(id: number): DistillJobRow | null {
    const r = this.deps.db.prepare(`SELECT * FROM distill_jobs WHERE id = ?`).get(id) as
      JobDbRow | undefined
    return r ? toRow(r) : null
  }

  private nextQueued(): JobDbRow | undefined {
    return this.deps.db
      .prepare(`SELECT * FROM distill_jobs WHERE state='queued' ORDER BY id ASC LIMIT 1`)
      .get() as JobDbRow | undefined
  }

  /**
   * Invariant: emit() never throws. Broadcasts are advisory UI notifications,
   * never load-bearing — job state persistence and kick-loop progress must not
   * depend on renderer liveness (e.g. webContents.send throwing after the
   * renderer has been destroyed). Any broadcast failure is logged and swallowed
   * so callers (enqueue/retry/runJob) keep their own throw contracts intact.
   */
  private emit(job: DistillJobRow): void {
    try {
      this.deps.broadcast({ caseSlug: job.caseSlug, job })
    } catch (err) {
      console.error('[distill] broadcast failed', err)
    }
  }

  private kick(): void {
    if (this.running) return
    this.running = true
    void (async () => {
      try {
        for (;;) {
          const next = this.nextQueued()
          if (!next) break
          await this.runJob(next)
        }
      } finally {
        this.running = false
        for (const w of this.waiters.splice(0)) w()
      }
    })()
  }

  private async runJob(r: JobDbRow): Promise<void> {
    const db = this.deps.db
    db.prepare(`UPDATE distill_jobs SET state='running' WHERE id=?`).run(r.id)
    this.emit(this.get(r.id)!)
    const finish = (fields: string, ...vals: (string | number | null)[]): void => {
      db.prepare(`UPDATE distill_jobs SET ${fields}, finished_at=? WHERE id=?`).run(
        ...vals,
        new Date().toISOString(),
        r.id
      )
      this.emit(this.get(r.id)!)
    }
    try {
      const input = JSON.parse(r.input_snapshot) as CaseDistillInput
      const run = await this.deps.distill(input)
      const res = this.deps.stage(r.case_slug, r.id, run.output)
      finish(`state='done', raw_output=?, item_count=?`, run.raw, res.staged)
    } catch (err) {
      if (err instanceof DistillParseError) {
        finish(`state='failed', error=?, raw_output=?`, err.message, err.raw)
      } else {
        finish(`state='failed', error=?`, err instanceof Error ? err.message : String(err))
      }
    }
  }
}
