import type { DatabaseSync } from 'node:sqlite'
import { createCase, getCase } from '../caseService'
import { createSession } from '../agent/sessionStore'
import {
  insertRoutineRun,
  attachRunSession,
  finishRoutineRun,
  listRoutineRuns,
  lastSuccessAt,
  lastAttemptAt
} from './runs'
import { ensureRoutineAnchor, forgetRoutineAnchor } from './anchors'
import { nextFireAfter } from './schedule'
import type { RoutineStore } from './store'
import type { RoutineDef, RoutinesPayload, RoutineTrigger } from '../../../shared/routines'
import type { BackgroundTurnParams, BackgroundTurnResult } from '../agent/background'

// Deliberately imports NO electron (same rule as agent/background.ts): the routines engine must
// stay pure Node so a future headless server can host it. Change announcement is the injected
// `notify` callback only — never BrowserWindow.

/**
 * What `runTurn` is handed: everything `runBackgroundTurn` needs, plus the driver kind this
 * routine asked for.
 *
 * `driverKind` is carried FORWARD rather than looked up backward. index.ts binds the driver, and
 * the alternative — reverse-mapping `params.caseSlug` to a routine through the store at run time
 * — would read the CURRENT definition, so editing or deleting a routine mid-run could resolve a
 * different driver than the session row this service already wrote. Here the kind is decided once,
 * at the same moment the session row records it, and the two cannot disagree.
 */
export interface RoutineTurnRequest extends BackgroundTurnParams {
  driverKind: string
}

export interface RoutinesServiceDeps {
  db: DatabaseSync
  argusHome: string
  store: RoutineStore
  /** Executes one background turn; production binds runBackgroundTurn + driver resolution
   *  in index.ts. Injected so these tests never touch a driver. */
  runTurn: (params: RoutineTurnRequest) => Promise<BackgroundTurnResult>
  /** Change announcement (index.ts wires broadcast). */
  notify?: () => void
  /**
   * The clock, for run timestamps AND for the first-seen anchor a never-run routine's schedule
   * is measured from (see anchors.ts). One clock, so what a test steps forward moves both.
   */
  now?: () => Date
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Turns a stored routine definition into an unattended agent run and records what happened.
 *
 * SERIAL BY CONSTRUCTION (spec §5): only one routine ever executes at a time. A `startRun`
 * (or `enqueue`) that arrives while another is in flight no longer throws — it joins a FIFO
 * `queue` instead, and `drain` sets `running` synchronously, before the detached execution
 * ever suspends, so a second call in the same tick already sees it.
 *
 * VALIDATION ORDER MATTERS: the id is resolved (unknown / disabled) BEFORE it is queued.
 * Checking busy first would report contention for a typo'd id, which is a wrong and confusing
 * answer to a question that has nothing to do with the run in flight.
 *
 * COALESCING IS BY ROUTINE: a routine already running, or already waiting in `queue`, is not
 * added again. Without this, a routine still executing when its next scheduled fire comes due
 * would stack up a backlog of itself.
 *
 * NO RUN IS EVER LEFT `running`. That is structural rather than careful: the run row is opened
 * FIRST and everything that follows — case creation, session creation, the turn itself — lives
 * inside one try/catch whose catch closes the row as `failed`. Nothing between the insert and
 * the finish can throw past it. A stuck `running` row would render as a routine executing
 * forever with no way back.
 */
export class RoutinesService {
  private running: RoutineDef | null = null
  private queue: { routine: RoutineDef; trigger: RoutineTrigger }[] = []
  private current: Promise<void> = Promise.resolve()

  constructor(private deps: RoutinesServiceDeps) {}

  /**
   * Invokes `deps.notify`, catching and logging anything it throws instead of letting it
   * propagate. `notify` wraps Electron's `webContents.send` in production, which throws
   * "Object has been destroyed" when a window closes mid-run — and this file must not assume
   * every caller remembers to guard against that (services/routines/ is required to stay pure
   * Node, hostable by a future headless server, so the queue's own integrity cannot depend on
   * one particular caller's wrapping). An uncaught throw here would land on call sites that sit
   * directly in the queue's control flow — most sharply `drain()`'s `.finally()`, where it would
   * skip the `this.drain()` continuation and stall the ENTIRE pending queue, not just the one
   * run in flight. Losing one UI refresh is strictly better than stalling the queue or
   * corrupting a run record.
   */
  private safeNotify(): void {
    try {
      this.deps.notify?.()
    } catch (err) {
      console.error('[routines] notify failed:', message(err))
    }
  }

  payload(): RoutinesPayload {
    return {
      routines: this.deps.store.list(),
      loadError: this.deps.store.loadError(),
      runningId: this.running?.id ?? null,
      queued: this.queue.map((e) => e.routine.id),
      // Guarded per routine, not delegated to nextRunAt itself: nextRunAt's throw on a
      // schema-busting schedule (schedule.ts) is the honest signal the scheduler catches and
      // logs per-tick — swallowing it inside nextRunAt would leave that scheduler with nothing
      // to log, and one broken routine would otherwise take down every OTHER routine's
      // nextRunAt (and hence the whole payload) with it. No production path produces such a
      // schedule today (the store parses routines.json as one document, so a bad entry reverts
      // the file to defaults instead); the isolation is what makes per-routine parsing a safe
      // change to make later.
      nextRunAt: Object.fromEntries(
        this.deps.store.list().map((r) => {
          try {
            return [r.id, this.nextRunAt(r)]
          } catch (err) {
            console.error(`[routines] nextRunAt failed for ${r.id}:`, message(err))
            return [r.id, null]
          }
        })
      ),
      runs: listRoutineRuns(this.deps.db)
    }
  }

  /**
   * When this routine next fires, ISO — or null if it never will on its own.
   *
   * THE single definition of due-ness. The scheduler compares this against the clock and the
   * Settings page prints it, so what the user is shown and what will actually happen cannot
   * drift apart.
   *
   * Returns null for a disabled routine as well as an unscheduled one, so neither caller has to
   * remember the `enabled` rule separately.
   *
   * WRITES on the first call for a never-run routine: `ensureRoutineAnchor` records the instant
   * this routine was first seen with a live schedule, and every later call reads it back. The
   * anchor has to be persisted rather than held here — see anchors.ts for what an in-memory one
   * does to a routine created hours into an app session. Only routines that pass the guard above
   * get a row, so a manual-only or disabled routine writes nothing.
   */
  nextRunAt(routine: RoutineDef): string | null {
    if (!routine.schedule || !routine.enabled) return null
    const attempt = lastAttemptAt(this.deps.db, routine.id)
    const anchor = attempt
      ? new Date(attempt)
      : new Date(ensureRoutineAnchor(this.deps.db, routine.id, this.deps.now))
    return nextFireAfter(routine.schedule, anchor).toISOString()
  }

  /**
   * Drops the engine-owned state for a routine whose definition has been deleted.
   *
   * Called by the host alongside `store.remove` — the store owns config/routines.json, and the
   * db rows it knows nothing about are this service's to clean up. Run history is deliberately
   * NOT touched: those rows are the audit trail for work that really happened, and the Settings
   * page renders them by id after the definition is gone.
   */
  forgetRoutine(id: string): void {
    forgetRoutineAnchor(this.deps.db, id)
  }

  /** Sync-validates (throws on unknown/disabled), then queues a manual run. */
  startRun(id: string): void {
    const routine = this.deps.store.get(id)
    if (!routine) throw new Error(`Unknown routine: ${id}`)
    if (!routine.enabled) throw new Error(`Routine is disabled: ${id}`)
    this.enqueue(routine, 'manual')
  }

  /**
   * Adds a routine to the serial queue, or does nothing if it is already running or queued.
   *
   * COALESCING IS SILENT ON PURPOSE. Increment 1 threw `A routine is already running`, which a
   * scheduler cannot act on: three routines set to 02:00 would mean two of them permanently
   * starved, tomorrow and every day after, because the same collision recurs. A caller that
   * genuinely needs to know can read `payload()`.
   *
   * De-duplication is BY ROUTINE, not by request: a routine still executing when its next fire
   * comes due must not stack up a backlog of itself.
   *
   * `running` is set synchronously inside `drain` before any suspension point, so a second
   * `enqueue` in the same tick already sees it.
   */
  enqueue(routine: RoutineDef, trigger: RoutineTrigger): void {
    if (this.running?.id === routine.id) return
    if (this.queue.some((e) => e.routine.id === routine.id)) return
    this.queue.push({ routine, trigger })
    this.safeNotify()
    if (!this.running) this.drain()
  }

  /**
   * Takes the next queue entry and runs it — against the definition AS IT STANDS NOW.
   *
   * The entry carries a snapshot taken at enqueue time, and the snapshot is not what executes.
   * A queued routine can wait behind a run of up to MAX_TIMEOUT_MINUTES and there is no cancel
   * anywhere in the product, so disabling or deleting it is the only lever the user has while it
   * waits; running the snapshot would ignore both and start an unattended run of a routine the
   * user had just switched off.
   *
   * This is NOT the "driverKind is carried forward, not looked up backward" rule breaking (see
   * the RoutineTurnRequest docblock). That rule protects a run already under way, whose session
   * row already names a driver: re-resolving THEN could execute a driver the record contradicts.
   * Nothing has been written for this run yet — `execute` opens its first row below — so
   * drain-start is the last moment at which the current definition is still the right answer.
   */
  private drain(): void {
    const next = this.queue.shift()
    if (!next) return
    const live = this.deps.store.get(next.routine.id)
    if (!live || !live.enabled) {
      // Announce (the id has left `queued`), then continue with the entry behind it. The
      // recursion is bounded by the queue length — every arm shifts an entry and nothing here
      // adds one.
      this.safeNotify()
      this.drain()
      return
    }
    this.running = live
    this.current = this.execute(live, next.trigger)
      // `execute` swallows its own failures into the run row, so this catch only fires if the
      // recording itself failed (e.g. a closed DB). It must still not escape: `current` is
      // handed out by `whenIdle`, which every test awaits, and a rejecting idle promise would
      // turn one bad run into an unhandled rejection that fails a suite far from its cause.
      .catch((err: unknown) => {
        console.error('[routines] run bookkeeping failed:', message(err))
      })
      .finally(() => {
        this.running = null
        this.safeNotify()
        // Serial continuation. Not stack recursion — this runs on a microtask.
        this.drain()
      })
  }

  /**
   * Resolves when nothing is running AND the queue is empty.
   *
   * NOTHING IN PRODUCTION CALLS THIS. The callers are the tests, and any future host that needs
   * to wait for the queue to empty. `before-quit` deliberately does not: it stops the scheduler
   * and closes the store, and a run still in flight is simply abandoned — its row is reconciled
   * to `failed` at the next launch (reconcileInterruptedRuns, runs.ts). That is the intended
   * behaviour, since a quit that blocked on an unattended turn could hang for up to
   * MAX_TIMEOUT_MINUTES. Do not read the widening below as quit protecting a run in flight.
   *
   * The loop is required, not defensive. `drain` replaces `current` with the NEXT run's promise
   * from inside the previous one's `.finally()`, so awaiting a single snapshot would resolve
   * while the queue still held work — which for a test means asserting against a database the
   * next run is still writing to. It terminates because the queue only shrinks here (each
   * iteration consumes the run that was in flight when it started) and `drain` never leaves
   * `running` set without either a queued successor or a settled `current`.
   */
  async whenIdle(): Promise<void> {
    while (this.running || this.queue.length) {
      await this.current
    }
  }

  private async execute(routine: RoutineDef, trigger: RoutineTrigger): Promise<void> {
    const { db, argusHome } = this.deps
    const slug = `routine-${routine.id}`
    // Opened before any fallible work so a setup failure is a recorded `failed` run rather than
    // an invisible no-op. routine_runs has no FK to cases (db.ts), so the row is legal even if
    // the case is never created.
    const runId = insertRoutineRun(db, routine.id, slug, trigger, this.deps.now)
    this.safeNotify()

    // One decision, two consumers: the session row below and the turn request further down.
    // Deriving it twice is how the recorded driver and the executing driver drift apart.
    const driverKind = routine.driverKind ?? 'claude-agent-sdk'

    let result: BackgroundTurnResult
    try {
      const rec =
        getCase(db, slug) ?? createCase(db, argusHome, { slug, title: `Routine: ${routine.name}` })
      const session = createSession(db, slug, {
        driverKind,
        model: routine.model ?? null
      })
      attachRunSession(db, runId, session.id)
      // Announce promptly: without this, every payload() consumer sees a `running` row whose
      // sessionId is still null for the entire run (up to timeoutMs), unable to link the row to
      // the live agent session while it's actually running — exactly when that link matters.
      this.safeNotify()

      /**
       * Read here, not at enqueue time: a run that waits in the queue behind another must see
       * the watermark as it stands when IT starts, not as it stood when it was queued.
       */
      const since = lastSuccessAt(db, routine.id)
      const watermark = since
        ? `Your last successful run of this routine finished at ${since}. Concentrate on what ` +
          `has changed since then.`
        : `This is the first run of this routine — there is no previous run to compare against.`

      const preamble =
        `You are running unattended as the routine "${routine.name}". No user is present: ` +
        `never ask questions, make reasonable assumptions, note anything that needs human ` +
        `review, and end with a concise summary of what you did and found.\n\n` +
        `${watermark}\n\n`

      result = await this.deps.runTurn({
        caseId: rec.id,
        caseSlug: slug,
        sessionId: session.id,
        driverKind,
        prompt: preamble + routine.prompt,
        timeoutMs: routine.timeoutMs,
        ...(routine.model ? { model: routine.model } : {})
      })
    } catch (err) {
      // runBackgroundTurn reports its own failures as a resolved `{ status: 'failed' }`, so this
      // covers the rest: case/session setup, and an injected runTurn that rejects.
      result = { status: 'failed', text: '', error: message(err) }
    }

    finishRoutineRun(
      db,
      runId,
      {
        status: result.status,
        // Partial text from a failed/timed-out turn is worth keeping as the summary.
        ...(result.text ? { summary: result.text } : {}),
        ...(result.error ? { error: result.error } : {})
      },
      this.deps.now
    )
  }
}
