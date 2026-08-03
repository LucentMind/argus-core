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
  distill: (input: CaseDistillInput, signal: AbortSignal) => Promise<CaseDistillRun>
  stage: (caseSlug: string, jobId: number, output: CaseDistillOutput) => StageResult
  broadcast: (payload: DistillStatusPayload) => void
  /** Version hash of the static distill prompt parts, stamped at enqueue. Absent in tests. */
  promptHash?: () => string
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
 * order; every state transition (running/done/failed/cancelled) is persisted then
 * broadcast. `idle()` is a test helper only — it must consult BOTH the `running`
 * flag and `nextQueued()` because `nextQueued()`'s `WHERE state='queued'` clause
 * excludes a job that is currently mid-flight (state='running'); checking the DB
 * alone would report "idle" while a job is actively running. Every `running`/DB-state
 * read used by `idle()` happens on the same synchronous call stack as the code that
 * mutates it (enqueue/retry set `running=true` synchronously inside `kick()`, before
 * any `await`; the loop's terminal `nextQueued()` check and the `finally` block's
 * `running=false` + waiter resolution run back-to-back with no intervening `await`),
 * so there is no window where external synchronous code could observe a torn state
 * — Node's single-threaded, run-to-completion execution combined with the
 * synchronous `node:sqlite` driver rules that out.
 *
 * `cancel()` is a third external synchronous mutator, called from an IPC handler
 * rather than from `kick()`, but it preserves the same invariant rather than
 * breaking it. On both a queued and a running job it does a single synchronous DB
 * write (state→'cancelled', finished_at→now) and emits, before returning; it never
 * touches the `running` flag either way — for a queued job, `nextQueued()`'s
 * `WHERE state='queued'` simply stops matching that row, same as if `kick()` had
 * consumed it; for a running job, `running` stays true until the loop's own
 * `finally` clears it once `runJob` actually returns. Only after that DB write and
 * emit does the running branch call `AbortController.abort()` — which synchronously
 * dispatches every listener registered on that signal, still on `cancel()`'s own
 * stack. Today the only such listener (`abortRacer` in `agent/driver.ts`) just
 * rejects a promise; it does not read or write `running` or the job row, so it
 * introduces no further synchronous state change here — but that is a fact about
 * today's listener, not a guarantee `abort()` itself makes. `runJob`'s own
 * aborted-path rewrite of the same terminal row (in its success-path guard and its
 * `catch`) runs later, on a separate turn once the driver's promise actually
 * settles, and is written to be a no-op over what `cancel()` already persisted.
 * Because `cancel()` never partially mutates state across an `await`, there is
 * still no window where a concurrent synchronous read (from `idle()` or `kick()`'s
 * loop) can observe torn state.
 */
export class DistillQueue {
  private running = false
  private waiters: (() => void)[] = []
  /** AbortController for the job currently in `runJob`, keyed by job id. At most one entry
   *  exists (the runner is single in-flight); it is deleted in runJob's `finally`. */
  private controllers = new Map<number, AbortController>()

  constructor(private deps: DistillQueueDeps) {}

  /**
   * running → failed('app quit mid-distill'); returns count of rows flipped.
   * A prior process can also quit between a job's INSERT (state='queued') and its
   * kick() loop ever running — that job survives the UPDATE above untouched, so
   * once recovery is done, resume the loop if anything is still queued.
   */
  recoverOnBoot(): number {
    const res = this.deps.db
      .prepare(
        `UPDATE distill_jobs SET state='failed', error='app quit mid-distill', finished_at=? WHERE state='running'`
      )
      .run(new Date().toISOString())
    if (this.nextQueued()) this.kick()
    return Number(res.changes)
  }

  /** Snapshots `assembleInput(slug)` NOW; throws only on snapshot failure (callers guard it). */
  enqueue(slug: string): DistillJobRow {
    const snapshot = JSON.stringify(this.deps.assembleInput(slug))
    const res = this.deps.db
      .prepare(
        `INSERT INTO distill_jobs (case_slug, state, input_snapshot, prompt_hash, created_at) VALUES (?, 'queued', ?, ?, ?)`
      )
      .run(slug, snapshot, this.deps.promptHash?.() ?? null, new Date().toISOString())
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

  /**
   * Stops a distillation the user no longer wants. Both a queued and a running job are
   * flipped straight to `cancelled` with `finished_at` set, synchronously, before this method
   * returns — so the row is already correct if the app quits moments later (`recoverOnBoot`
   * only rewrites `state='running'` rows; a `cancelled` row is untouched, unlike the failed
   * "app quit mid-distill" row a still-running job would produce). For a queued job that write
   * alone is enough: the kick loop's `WHERE state='queued'` then skips it, same as if `kick()`
   * had consumed it. For a running job, the write happens first and its `AbortController` is
   * aborted only after — aborting rejects the driver's race and tears its CLI down. `runJob`'s
   * own aborted-path handling then rewrites the same terminal row on a later turn once the
   * driver's promise actually settles; that rewrite is a no-op over what's already persisted
   * here (see `finishCancelled` in `runJob`), kept for the case where `runJob` reaches that
   * branch some other way.
   *
   * Deliberately idempotent on a resting job (done/failed/cancelled): "it finished while
   * the menu was open" is an ordinary race, not an error. Re-cancelling an already-cancelled
   * job returns the row unchanged — state and `finished_at` both. Only an unknown id throws.
   */
  cancel(jobId: number): DistillJobRow {
    const job = this.get(jobId)
    if (!job) throw new Error(`distill job ${jobId} not found`)
    if (job.state !== 'running' && job.state !== 'queued') return job
    const wasRunning = job.state === 'running'
    this.deps.db
      .prepare(`UPDATE distill_jobs SET state='cancelled', finished_at=? WHERE id=?`)
      .run(new Date().toISOString(), jobId)
    const fresh = this.get(jobId)!
    this.emit(fresh)
    if (wasRunning) this.controllers.get(jobId)?.abort()
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
    const ac = new AbortController()
    this.controllers.set(r.id, ac)
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
    // cancel() already persists state='cancelled' (with finished_at) synchronously, before it
    // ever aborts this job's controller — see DistillQueue.cancel. So by the time either
    // aborted-branch below runs, the row is already terminal. This keeps that terminal write
    // idempotent: COALESCE preserves the finished_at cancel() already stamped instead of
    // moving it forward just because the driver took longer to unwind.
    const finishCancelled = (): void => {
      db.prepare(
        `UPDATE distill_jobs SET state='cancelled', finished_at=COALESCE(finished_at, ?) WHERE id=?`
      ).run(new Date().toISOString(), r.id)
      this.emit(this.get(r.id)!)
    }
    try {
      const input = JSON.parse(r.input_snapshot) as CaseDistillInput
      const run = await this.deps.distill(input, ac.signal)
      // A driver can resolve normally even though its signal was already aborted — it lost or
      // ignored the abort race (e.g. its CLI process happened to finish right as cancel() fired).
      // Honour the cancellation anyway: the user pressed cancel, so nothing from this run reaches
      // the proposals tray.
      if (ac.signal.aborted) {
        finishCancelled()
        return
      }
      const res = this.deps.stage(r.case_slug, r.id, run.output)
      finish(`state='done', raw_output=?, item_count=?`, run.raw, res.staged)
    } catch (err) {
      if (ac.signal.aborted) {
        // However the run failed, the user's cancel is the reason it stopped — record that
        // rather than a driver-shaped error the user would read as a fault. Already persisted
        // by cancel() itself; finishCancelled() above documents why this rewrite is idempotent.
        finishCancelled()
      } else if (err instanceof DistillParseError) {
        finish(`state='failed', error=?, raw_output=?`, err.message, err.raw)
      } else {
        finish(`state='failed', error=?`, err instanceof Error ? err.message : String(err))
      }
    } finally {
      this.controllers.delete(r.id)
    }
  }
}
