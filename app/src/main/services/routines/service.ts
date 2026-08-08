import type { DatabaseSync } from 'node:sqlite'
import { createCase, getCase } from '../caseService'
import { createSession } from '../agent/sessionStore'
import {
  insertRoutineRun,
  attachRunSession,
  finishRoutineRun,
  listRoutineRuns,
  lastSuccessAt
} from './runs'
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
      runs: listRoutineRuns(this.deps.db)
    }
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

  private drain(): void {
    const next = this.queue.shift()
    if (!next) return
    this.running = next.routine
    this.current = this.execute(next.routine, next.trigger)
      // `execute` swallows its own failures into the run row, so this catch only fires if the
      // recording itself failed (e.g. a closed DB). It must still not escape: `whenIdle` is
      // awaited by shutdown and by every test, and a rejecting idle promise would turn one bad
      // run into an unhandled rejection.
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
   * Resolves when nothing is running AND the queue is empty — for tests and shutdown.
   *
   * The loop is required, not defensive. `drain` replaces `current` with the NEXT run's promise
   * from inside the previous one's `.finally()`, so awaiting a single snapshot would resolve
   * while the queue still held work — and shutdown awaits this. It terminates because the queue
   * only shrinks here (each iteration consumes the run that was in flight when it started) and
   * `drain` never leaves `running` set without either a queued successor or a settled `current`.
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
