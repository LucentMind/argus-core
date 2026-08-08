import type { DatabaseSync } from 'node:sqlite'
import { createCase, getCase } from '../caseService'
import { createSession } from '../agent/sessionStore'
import { insertRoutineRun, attachRunSession, finishRoutineRun, listRoutineRuns } from './runs'
import type { RoutineStore } from './store'
import type { RoutineDef, RoutinesPayload } from '../../../shared/routines'
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
 * SERIAL BY CONSTRUCTION (spec §5): `running` is set synchronously inside `startRun`, before the
 * detached execution ever suspends, so a second `startRun` in the same tick already sees it.
 *
 * VALIDATION ORDER MATTERS: the id is resolved (unknown / disabled) BEFORE the busy check.
 * Checking busy first would report `A routine is already running` for a typo'd id, which is a
 * wrong and confusing answer to a question that has nothing to do with the run in flight.
 *
 * NO RUN IS EVER LEFT `running`. That is structural rather than careful: the run row is opened
 * FIRST and everything that follows — case creation, session creation, the turn itself — lives
 * inside one try/catch whose catch closes the row as `failed`. Nothing between the insert and
 * the finish can throw past it. A stuck `running` row would render as a routine executing
 * forever with no way back.
 */
export class RoutinesService {
  private running: RoutineDef | null = null
  private current: Promise<void> = Promise.resolve()

  constructor(private deps: RoutinesServiceDeps) {}

  payload(): RoutinesPayload {
    return {
      routines: this.deps.store.list(),
      loadError: this.deps.store.loadError(),
      runningId: this.running?.id ?? null,
      runs: listRoutineRuns(this.deps.db)
    }
  }

  /** Sync-validates (throws on unknown/disabled/busy), then detaches execution. */
  startRun(id: string): void {
    const routine = this.deps.store.get(id)
    if (!routine) throw new Error(`Unknown routine: ${id}`)
    if (!routine.enabled) throw new Error(`Routine is disabled: ${id}`)
    if (this.running) throw new Error('A routine is already running')
    this.running = routine
    this.current = this.execute(routine)
      // `execute` swallows its own failures into the run row, so this catch only fires if the
      // recording itself failed (e.g. a closed DB). It must still not escape: `whenIdle` is
      // awaited by shutdown and by every test, and a rejecting idle promise would turn one bad
      // run into an unhandled rejection.
      .catch((err: unknown) => {
        console.error('[routines] run bookkeeping failed:', message(err))
      })
      .finally(() => {
        this.running = null
        this.deps.notify?.()
      })
  }

  /**
   * Resolves when no run is executing — for tests and shutdown.
   *
   * Never rejects and never pends forever: before the first `startRun` it is an
   * already-resolved promise, and afterwards it is the (caught) tail of the latest run, which
   * resolves on the failure paths exactly as it does on the success path.
   */
  whenIdle(): Promise<void> {
    return this.current
  }

  private async execute(routine: RoutineDef): Promise<void> {
    const { db, argusHome } = this.deps
    const slug = `routine-${routine.id}`
    // Opened before any fallible work so a setup failure is a recorded `failed` run rather than
    // an invisible no-op. routine_runs has no FK to cases (db.ts), so the row is legal even if
    // the case is never created.
    const runId = insertRoutineRun(db, routine.id, slug, 'manual', this.deps.now)
    this.deps.notify?.()

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
      this.deps.notify?.()

      const preamble =
        `You are running unattended as the routine "${routine.name}". No user is present: ` +
        `never ask questions, make reasonable assumptions, note anything that needs human ` +
        `review, and end with a concise summary of what you did and found.\n\n`

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
