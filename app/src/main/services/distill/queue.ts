import type { DatabaseSync } from 'node:sqlite'
import type {
  CaseDistillInput,
  CaseDistillOutput,
  DistillJobRow,
  DistillStatusPayload
} from '../../../shared/distill'
import type { CaseDistillRun } from './caseDistiller'
import { DistillAgentRunError } from './caseDistiller'
import type { HeadlessResult, TrajectoryEntry } from '../agent/driver'
import type { StageResult } from './staging'
import { DistillParseError } from './contract'
import {
  DIGEST_CASE_SLUG,
  digestStale,
  readRejectDigest,
  rebuildRejectDigest
} from './rejectDigest'
import type { listArchivedProposals } from '../proposals'

/** Cap on the `trajectory_json` column, in JSON-serialized characters. A run that hits its
 *  iteration/timeout budget can accumulate a long trajectory; keeping the FIRST entries (not
 *  the last) matters because loop-start context — what the agent tried first, before it got
 *  stuck repeating itself — is what a human diagnosing a runaway actually needs. */
export const TRAJECTORY_JSON_CAP = 32_768

/** Serializes `trajectory` for the `trajectory_json` column, truncated to the first entries
 *  that fit under `TRAJECTORY_JSON_CAP`. `undefined` (no trajectory collected, e.g. a v1 run)
 *  maps to `null`; an empty array still round-trips as `'[]'`. */
function trajectoryJson(trajectory: TrajectoryEntry[] | undefined): string | null {
  if (!trajectory) return null
  const full = JSON.stringify(trajectory)
  if (full.length <= TRAJECTORY_JSON_CAP) return full
  const kept: TrajectoryEntry[] = []
  for (const entry of trajectory) {
    if (JSON.stringify([...kept, entry]).length > TRAJECTORY_JSON_CAP) break
    kept.push(entry)
  }
  return JSON.stringify(kept)
}

export interface DistillQueueDeps {
  db: DatabaseSync
  /** Throws → caller sees the throw; nothing is enqueued (guarded by callers). */
  assembleInput: (slug: string) => CaseDistillInput
  distill: (input: CaseDistillInput, signal: AbortSignal) => Promise<CaseDistillRun>
  stage: (caseSlug: string, jobId: number, output: CaseDistillOutput) => StageResult
  broadcast: (payload: DistillStatusPayload) => void
  /** Version hash of the static distill prompt parts, stamped at enqueue. Absent in tests. */
  promptHash?: () => string
  /** Home dir passed straight to rejectDigest's file I/O (reads/writes reject-patterns.md). */
  argusHome: string
  /** Archived proposals, freshest read each call — used both by `enqueue`'s stale pre-check
   *  and again at digest-job run time (the two calls can see different counts if rejects landed
   *  in between; that is fine, the run-time count is what actually gets persisted). */
  listArchivedProposalsFn: () => ReturnType<typeof listArchivedProposals>
  /** One-shot (non-agentic) headless runner — Task 10's `headlessRun`, widened. The digest LLM
   *  step is a single batch prompt, not a tool-using agent run, so this is deliberately NOT
   *  `distill` (the case-job agentic runner). */
  runOneShot: (prompt: string) => Promise<HeadlessResult>
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
  kind: string
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  duration_ms: number | null
  prompt_chars: number | null
  turn_count: number | null
  tool_call_count: number | null
  trajectory_json: string | null
  dropped_json: string | null
}

function toRow(r: JobDbRow): DistillJobRow {
  return {
    id: r.id,
    caseSlug: r.case_slug,
    state: r.state as DistillJobRow['state'],
    error: r.error,
    itemCount: r.item_count,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    costUsd: r.cost_usd,
    turnCount: r.turn_count,
    toolCallCount: r.tool_call_count,
    promptChars: r.prompt_chars
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

  /**
   * Snapshots `assembleInput(slug)` NOW; throws only on snapshot failure (callers guard it).
   *
   * Guards "at most one queued-or-running job per case" itself, for every caller, rather than
   * leaving it to whichever call site remembers to wrap this in `reconcileAndEnqueue` — two IPC
   * handlers (`distillRetry`, and until this fix `distillRedistill`) reached this method directly
   * with no guard, and any future caller could do the same. The cancel happens AFTER the insert,
   * not before: `assembleInput` above can throw, and if it does, nothing has been touched yet —
   * an already-in-flight job for this slug survives untouched rather than being destroyed with no
   * replacement queued (see the F5 regression test). `cancelOtherInFlight` also cancels EVERY
   * other queued/running row for the slug, not just the newest one `statusFor` would see (see the
   * F4 regression test).
   */
  enqueue(slug: string): DistillJobRow {
    // Pre-check BEFORE the case snapshot: a digest job, if inserted, must land with a LOWER id
    // than the case row below so the FIFO loop (ORDER BY id ASC) runs it first — the case job's
    // own run-start merge (see runJob) picks up whatever the digest wrote. This is deliberately
    // independent bookkeeping, not part of the "one job per case" invariant `assembleInput`
    // guards below: a digest job for the sentinel slug never competes with, or gets cancelled
    // by, a case job's `cancelOtherInFlight` (different case_slug).
    this.maybeEnqueueDigest()
    const snapshot = JSON.stringify(this.deps.assembleInput(slug))
    const res = this.deps.db
      .prepare(
        `INSERT INTO distill_jobs (case_slug, state, input_snapshot, prompt_hash, created_at) VALUES (?, 'queued', ?, ?, ?)`
      )
      .run(slug, snapshot, this.deps.promptHash?.() ?? null, new Date().toISOString())
    const job = this.get(Number(res.lastInsertRowid))!
    this.emit(this.getRaw(job.id)!)
    this.cancelOtherInFlight(slug, job.id)
    this.kick()
    return job
  }

  /**
   * Inserts a `kind='reject-digest'` row when the digest is stale AND none is already
   * queued/running — the second check keeps a burst of case enqueues (e.g. several cases closed
   * in quick succession, all seeing the same stale digest before the first rebuild lands) from
   * piling up redundant digest jobs for the shared sentinel slug. Never calls `kick()` itself;
   * the case-row insert immediately after it does, and `nextQueued()`'s `ORDER BY id ASC` picks
   * up this lower-id row first regardless of which call triggers the loop.
   */
  private maybeEnqueueDigest(): void {
    const rejects = this.deps.listArchivedProposalsFn().filter((p) => p.status === 'rejected')
    if (!digestStale(this.deps.argusHome, rejects.length)) return
    const pending = this.deps.db
      .prepare(
        `SELECT id FROM distill_jobs WHERE kind='reject-digest' AND state IN ('queued','running')`
      )
      .get()
    if (pending) return
    const res = this.deps.db
      .prepare(
        `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at, kind) VALUES (?, 'queued', '{}', ?, 'reject-digest')`
      )
      .run(DIGEST_CASE_SLUG, new Date().toISOString())
    this.emit(this.getRaw(Number(res.lastInsertRowid))!)
  }

  /**
   * failed → queued, reusing the original snapshot. Throws if the job isn't failed, OR if
   * another queued/running job already exists for the same slug.
   *
   * NOT the same in-flight guard as `enqueue` — deliberately. `enqueue`/`retry` both hold "at
   * most one queued-or-running job per case", but `retry` re-queues a job whose id can be
   * arbitrarily OLDER than a job that started after it failed (the user retries a stale failure
   * row while a fresh distill from the menu is already running). `statusFor` is `MAX(id)`, and
   * every renderer read (the case menu, the bar chip, every mount/case-switch/new-window/restart)
   * goes through it — so cancelling the newer job here, the way `enqueue` cancels other in-flight
   * rows, would silently kill live work: the newer job vanishes from the UI mid-run with no
   * broadcast the user would connect to their retry click, and no way left to cancel it. Refusing
   * instead makes a stale retry a harmless no-op: the old failed row stays failed (the caller's
   * `.catch` — DistillChip's failed-state retry button — resyncs from `status(slug)` on any
   * rejection, so the UI recovers on its own) and the fresher job survives untouched. See the N1
   * regression test.
   */
  retry(jobId: number): DistillJobRow {
    const raw = this.getRaw(jobId)
    if (!raw || raw.state !== 'failed') throw new Error(`distill job ${jobId} is not failed`)
    // Digest jobs are never manually retried: there is no UI surface for it (the case-retry
    // button only ever reads/writes case_slug rows), and a stale digest already self-heals — the
    // next case enqueue's `maybeEnqueueDigest` pre-check sees the same stale reject_count and
    // queues a fresh rebuild on its own. Refusing here keeps `retry`'s in-flight guard below
    // (keyed on case_slug) from ever having to reason about the shared sentinel slug.
    if (raw.kind !== 'case')
      throw new Error(`distill job ${jobId} has kind='${raw.kind}', not retryable`)
    const job = this.get(jobId)!
    const inFlight = this.deps.db
      .prepare(`SELECT id FROM distill_jobs WHERE case_slug=? AND state IN ('queued','running')`)
      .get(job.caseSlug) as { id: number } | undefined
    if (inFlight)
      throw new Error(
        `distill job ${jobId} cannot be retried: case ${job.caseSlug} already has an in-flight job (${inFlight.id})`
      )
    // Resets every v2 column too — a retried job must start with a clean slate, not the
    // previous attempt's cost/turns/trajectory sitting on a row that reads state='queued'
    // (contradicting toRow's/DistillJobRow's own "null until a job records them" contract).
    this.deps.db
      .prepare(
        `UPDATE distill_jobs SET state='queued', error=NULL, raw_output=NULL, item_count=NULL,
         finished_at=NULL, input_tokens=NULL, output_tokens=NULL, cost_usd=NULL, duration_ms=NULL,
         prompt_chars=NULL, turn_count=NULL, tool_call_count=NULL, trajectory_json=NULL,
         dropped_json=NULL WHERE id=?`
      )
      .run(jobId)
    const fresh = this.get(jobId)!
    this.emit(this.getRaw(jobId)!)
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
   * own aborted-path branches (its success-path guard and its `catch`) then run on a later turn
   * once the driver's promise actually settles. Only the `finished_at` WRITE inside them is
   * redundant over what's already persisted here (see `finishCancelled` in `runJob`) — the
   * BRANCH itself is not vestigial: it is the only thing standing between this cancelled row
   * and `runJob` silently overwriting it with `state='done'` (staging proposals from a
   * cancelled run, if the driver resolved instead of rejecting) or `state='failed'` (the exact
   * red "distill failed — retry" this feature exists to prevent).
   *
   * This is also where this class's usual invariant — DB says `running` ⟺ a controller is
   * live in `controllers` — stops holding: from this write until `runJob`'s `finally` deletes
   * the map entry, the row is terminal while its controller is still live. That's safe only
   * because nothing outside `cancel()` ever reads `controllers`, and `cancel()`'s own
   * resting-state early return (above) means a second `cancel()` on the same job never
   * consults that orphaned controller again.
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
    this.emit(this.getRaw(jobId)!)
    if (wasRunning) {
      // Under this design a running row always has a live controller — runJob sets it before
      // flipping state to 'running', and cancel() is the only place that flips state away from
      // 'running' without going through runJob's own finally. If that ever stops holding, abort
      // silently no-ops: the row stays 'cancelled' (already persisted above) but the driver
      // keeps running unaborted, and if it later resolves, runJob's success path would stage
      // proposals from a cancelled run and overwrite this row with state='done'. Surface that
      // instead of swallowing it.
      const ac = this.controllers.get(jobId)
      if (!ac)
        console.error(
          `[distill] job ${jobId} was running with no controller; cancel cannot abort it`
        )
      ac?.abort()
    }
    return fresh
  }

  /** Latest CASE job (highest id) for slug, or null. Blind to other kinds (e.g. reject-digest)
   *  sharing this table — every renderer/close-flow read of "the case's distill status" must
   *  see only case jobs, never a digest row that happens to have a higher id. */
  statusFor(slug: string): DistillJobRow | null {
    const r = this.deps.db
      .prepare(
        `SELECT * FROM distill_jobs WHERE case_slug = ? AND kind='case' ORDER BY id DESC LIMIT 1`
      )
      .get(slug) as JobDbRow | undefined
    return r ? toRow(r) : null
  }

  /** Test helper: resolves once nothing is queued or running. See class docs for race analysis. */
  idle(): Promise<void> {
    if (!this.running && !this.nextQueued()) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private get(id: number): DistillJobRow | null {
    const r = this.getRaw(id)
    return r ? toRow(r) : null
  }

  private getRaw(id: number): JobDbRow | undefined {
    return this.deps.db.prepare(`SELECT * FROM distill_jobs WHERE id = ?`).get(id) as
      JobDbRow | undefined
  }

  private nextQueued(): JobDbRow | undefined {
    return this.deps.db
      .prepare(`SELECT * FROM distill_jobs WHERE state='queued' ORDER BY id ASC LIMIT 1`)
      .get() as JobDbRow | undefined
  }

  /**
   * Cancels every OTHER queued/running row for `slug` — everything but `excludeId`, which is
   * always the row the caller (enqueue/retry) just created or just flipped to queued. Excluding
   * it matters: right after `enqueue`'s INSERT, the new row itself is still `state='queued'`
   * (kick() may not have picked it up yet), so an unfiltered query would immediately cancel the
   * job the caller is trying to start. Uses `cancel()` per row rather than a bulk UPDATE so a
   * running row still gets its `AbortController` aborted, not just its DB state flipped.
   */
  private cancelOtherInFlight(slug: string, excludeId: number): void {
    const rows = this.deps.db
      .prepare(
        `SELECT id FROM distill_jobs WHERE case_slug=? AND state IN ('queued','running') AND id != ?`
      )
      .all(slug, excludeId) as { id: number }[]
    for (const { id } of rows) this.cancel(id)
  }

  /**
   * Invariant: emit() never throws. Broadcasts are advisory UI notifications,
   * never load-bearing — job state persistence and kick-loop progress must not
   * depend on renderer liveness (e.g. webContents.send throwing after the
   * renderer has been destroyed). Any broadcast failure is logged and swallowed
   * so callers (enqueue/retry/runJob) keep their own throw contracts intact.
   *
   * Takes the RAW db row (not `DistillJobRow`) so it can see `kind` and skip broadcasting
   * entirely for anything but a case job. `useDistillJob` (renderer) adopts ANY payload for its
   * subscribed slug with no kind filter of its own — a digest row broadcasting under the
   * sentinel slug would only ever matter to a window that happened to be showing a case actually
   * named `__reject-digest__`, which can't exist, but "can't happen today" is not a reason to
   * leave a kind-blind broadcast lying around for a future caller to trip over. Every call site
   * in this file passes a fresh `getRaw()` read, never the `DistillJobRow` already in hand.
   */
  private emit(raw: JobDbRow): void {
    if (raw.kind !== 'case') return
    try {
      this.deps.broadcast({ caseSlug: raw.case_slug, job: toRow(raw) })
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
    const finish = (fields: string, ...vals: (string | number | null)[]): void => {
      db.prepare(`UPDATE distill_jobs SET ${fields}, finished_at=? WHERE id=?`).run(
        ...vals,
        new Date().toISOString(),
        r.id
      )
      this.emit(this.getRaw(r.id)!)
    }
    // cancel() already persists state='cancelled' (with finished_at) synchronously, before it
    // ever aborts this job's controller — see DistillQueue.cancel. Both aborted-branches below
    // (the success-path guard and the catch) exist to detect that and stop this method from
    // clobbering the already-terminal row: drop the success-path guard and a driver that
    // resolves after cancel() still reaches stage()/finish(state='done'), staging proposals
    // from a cancelled run; drop the catch's check and the abort rejection falls through to
    // finish(state='failed'), overwriting 'cancelled' with the exact red "distill failed —
    // retry" this feature exists to prevent. Only the finished_at WRITE below is redundant by
    // the time either branch runs — COALESCE preserves the finished_at cancel() already
    // stamped instead of moving it forward just because the driver took longer to unwind.
    const finishCancelled = (): void => {
      db.prepare(
        `UPDATE distill_jobs SET state='cancelled', finished_at=COALESCE(finished_at, ?) WHERE id=?`
      ).run(new Date().toISOString(), r.id)
      this.emit(this.getRaw(r.id)!)
    }
    try {
      // Prologue (controller registration + the running-state write) now lives inside this try:
      // if the UPDATE throws (locked/corrupt DB), execution falls into the catch below instead
      // of escaping past the `finally`, which would otherwise leak this job's controller in the
      // map for the process lifetime. `ac.signal.aborted` is false here (nothing has aborted
      // yet), so a prologue failure lands in the plain-error branch and is recorded as a normal
      // `finish(state='failed', ...)`, same as any other mid-run failure.
      this.controllers.set(r.id, ac)
      db.prepare(`UPDATE distill_jobs SET state='running' WHERE id=?`).run(r.id)
      this.emit(this.getRaw(r.id)!)
      // Reject-digest rows never reach the agentic case runner below — their input shape (`{}`)
      // doesn't match what it expects, and rebuilding the digest is a single one-shot LLM call,
      // not a tool-using agent run. No staging: a digest job produces a standing-guidance file,
      // never proposals. On failure this falls through to the generic `catch` below and the row
      // ends up `state='failed'` — deliberately NOT retried automatically here: the digest stays
      // stale, and the next case enqueue's `maybeEnqueueDigest` pre-check (still seeing the same
      // stale reject_count) queues a fresh rebuild on its own. The case job(s) already queued
      // behind it are unaffected — they read whatever `readRejectDigest` finds (possibly still
      // the previous, staler file, or nothing) at their own run-start merge below.
      if (r.kind === 'reject-digest') {
        const rejects = this.deps.listArchivedProposalsFn().filter((p) => p.status === 'rejected')
        await rebuildRejectDigest(this.deps.argusHome, this.deps.runOneShot, rejects.length, r.id)
        // Same "a result can land after cancel()" race the case path guards against below —
        // cancel() may have already flipped this row to 'cancelled' (and synchronously aborted
        // `ac`) while `runOneShot` was still in flight. Must not clobber that with 'done'.
        if (ac.signal.aborted) {
          finishCancelled()
          return
        }
        finish(`state='done', item_count=?`, 0)
        return
      }
      if (r.kind !== 'case') {
        throw new Error(
          `distill job ${r.id} has kind='${r.kind}', not runnable by the case distiller (yet)`
        )
      }
      const input = JSON.parse(r.input_snapshot) as CaseDistillInput
      // Run-start merge (Task 13): read whatever the digest currently says — NOT whatever it
      // said at enqueue time, since a digest job queued ahead of this one (or one that landed
      // later, e.g. another case's close raced this one) may have rewritten the file since this
      // row's snapshot was taken — and patch it into the input BEFORE the prompt is built, then
      // persist the merged snapshot back to this row. The row alone must be able to reconstruct
      // the exact prompt on replay (recoverOnBoot / a future re-run), so the merge has to be
      // written to disk here, not just held in the in-memory `input` local.
      const digest = readRejectDigest(this.deps.argusHome)
      if (digest) {
        input.rejectDigest = digest.text
        db.prepare(`UPDATE distill_jobs SET input_snapshot=? WHERE id=?`).run(
          JSON.stringify(input),
          r.id
        )
      }
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
      // dropped_json is Task 14's stage-result field; `stage()` doesn't produce it yet, so it's
      // unconditionally null until then.
      finish(
        `state='done', raw_output=?, item_count=?, input_tokens=?, output_tokens=?, cost_usd=?, duration_ms=?, prompt_chars=?, turn_count=?, tool_call_count=?, trajectory_json=?, dropped_json=?`,
        run.raw,
        res.staged,
        run.usage?.inputTokens ?? null,
        run.usage?.outputTokens ?? null,
        run.usage?.costUsd ?? null,
        run.usage?.durationMs ?? null,
        run.promptChars ?? null,
        run.turnCount ?? null,
        run.toolCallCount ?? null,
        trajectoryJson(run.trajectory),
        null
      )
    } catch (err) {
      if (ac.signal.aborted) {
        // However the run failed, the user's cancel is the reason it stopped — record that
        // rather than a driver-shaped error the user would read as a fault. Already persisted
        // by cancel() itself; finishCancelled() above documents why this rewrite is idempotent.
        finishCancelled()
      } else if (err instanceof DistillAgentRunError) {
        // Every agentic-run failure — a capHit cutoff OR an ordinary clean-but-unparseable
        // run (the more common of the two) — carries agentMeta: it still burned real
        // tokens/turns, and §8's "record cost on every job" applies to a failed job the same
        // as a done one. Persist the usage/trajectory columns alongside raw_output on this
        // FAILED row, same fields the success path records (minus item_count/dropped_json,
        // which only make sense once staging actually ran).
        const m = err.agentMeta
        finish(
          `state='failed', error=?, raw_output=?, input_tokens=?, output_tokens=?, cost_usd=?, duration_ms=?, prompt_chars=?, turn_count=?, tool_call_count=?, trajectory_json=?`,
          err.message,
          err.raw,
          m?.usage?.inputTokens ?? null,
          m?.usage?.outputTokens ?? null,
          m?.usage?.costUsd ?? null,
          m?.usage?.durationMs ?? null,
          m?.promptChars ?? null,
          m?.turnCount ?? null,
          m?.toolCallCount ?? null,
          trajectoryJson(m?.trajectory)
        )
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

/**
 * Named wrapper around `enqueue()`, kept as the call-site spelling for both the case-close path
 * (`onCaseClosed`) and the redistill IPC path (`IPC.distillRedistill`): distilling an OPEN case
 * (job A, running) and then either closing it or redistilling it again (job B, a fresh snapshot)
 * must leave exactly one in-flight job for the slug — every renderer surface reads the newest job
 * by id, so if both survived, Cancel would stop B while A kept running unaborted and, on
 * completion, staged proposals built from a stale snapshot into the proposals tray — exactly what
 * cancel exists to prevent.
 *
 * The actual guard now lives in `enqueue()` itself (see its doc comment) rather than here: this
 * function used to do its own read-current/cancel-then-enqueue dance, which (a) only ever looked
 * at the single newest job via `statusFor()`, missing a slug that held more than one in-flight row
 * (F4), and (b) cancelled BEFORE enqueueing, so a snapshot failure in the new `enqueue()` call
 * would destroy the running job with nothing queued to replace it (F5). Moving the guard inside
 * `enqueue()` fixes both for every caller at once, including ones that call `enqueue()` directly
 * — this wrapper is what it looks like once that's true.
 */
export function reconcileAndEnqueue(queue: DistillQueue, slug: string): DistillJobRow {
  return queue.enqueue(slug)
}

/**
 * Whether the case-close confirm dialog's distill checkbox should default checked: no job has
 * ever run, the last one failed/was cancelled with nothing to show for it, or evidence arrived
 * after the last successful job's snapshot was taken (its `created_at`, not `finishedAt` — that's
 * the moment `assembleInput` actually ran). A job still queued/running already covers this close,
 * so defaults to unchecked rather than suggesting a second one.
 */
export function needsDistillRun(db: DatabaseSync, queue: DistillQueue, slug: string): boolean {
  const job = queue.statusFor(slug)
  if (!job) return true
  if (job.state === 'queued' || job.state === 'running') return false
  if (job.state === 'failed' || job.state === 'cancelled') return true
  const row = db
    .prepare(
      `SELECT MAX(e.created_at) as maxCreated FROM evidence e JOIN cases c ON c.id = e.case_id WHERE c.slug = ?`
    )
    .get(slug) as { maxCreated: string | null } | undefined
  if (!row?.maxCreated) return false
  return row.maxCreated > job.createdAt
}
