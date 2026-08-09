import type { DatabaseSync } from 'node:sqlite'
import {
  createCase,
  ensureCaseOrigin,
  getCase,
  setCaseReviewState,
  setCaseStatus,
  setCaseTriage
} from '../caseService'
import { createSession } from '../agent/sessionStore'
import {
  insertRoutineRun,
  attachRunSession,
  finishRoutineRun,
  listRoutineRuns,
  lastSuccessAt,
  lastAttemptAt,
  markRunReviewed,
  markAllRunsReviewed,
  countUnreviewedRuns
} from './runs'
import {
  attemptedItemKeys,
  attachItemCase,
  finishRunItem,
  getRunItem,
  insertRunItem,
  listRunItems
} from './runItems'
import { ensureRoutineAnchor, forgetRoutineAnchor } from './anchors'
import { forgetRoutineCursor, readRoutineCursor, writeRoutineCursor } from './cursors'
import { selectCaseItems, selectJqlItems, type Selection } from './items'
import { resolveCaseCandidates, type ScopeResolver } from './scopeResolver'
import { nextFireAfter } from './schedule'
import type { RoutineStore } from './store'
import {
  DEFAULT_ITEMS_PER_RUN,
  type RoutineDef,
  type RoutineScope,
  type RoutinesPayload,
  type RoutineTrigger
} from '../../../shared/routines'
import type { CaseResolution } from '../../../shared/types'
import {
  TURN_ABORTED_ERROR,
  type BackgroundTurnParams,
  type BackgroundTurnResult
} from '../agent/background'

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

/** What a finished run tells its host. Enough to render a notification without a second read. */
export interface RoutineRunFinished {
  runId: number
  routineId: string
  routineName: string
  status: BackgroundTurnResult['status']
  summary?: string
  error?: string
}

export interface RoutinesServiceDeps {
  db: DatabaseSync
  argusHome: string
  store: RoutineStore
  /** Executes one background turn; production binds runBackgroundTurn + driver resolution
   *  in index.ts. Injected so these tests never touch a driver. */
  runTurn: (params: RoutineTurnRequest) => Promise<BackgroundTurnResult>
  /**
   * Turns a scope into items. Absent = no routine may use a scope (a scoped run records itself
   * `failed` rather than silently doing nothing); index.ts always binds it.
   *
   * Injected because the jira half needs the Atlassian client, which this directory must not
   * import — see scopeResolver.ts.
   */
  scopeResolver?: ScopeResolver
  /** Change announcement (index.ts wires broadcast). */
  notify?: () => void
  /**
   * One finished run, announced. Separate from `notify` (which is payload-free and fires on
   * every change, including a run STARTING) because a notification must fire once, at the end,
   * and needs to know which run and how it went.
   *
   * A callback, not a Notification: services/routines/ imports no electron, so the host decides
   * what "announce" means — the tray host shows an OS notification, a future headless server
   * might write a log line or post a webhook.
   */
  onRunFinished?: (info: RoutineRunFinished) => void
  /**
   * The clock, for run timestamps AND for the first-seen anchor a never-run routine's schedule
   * is measured from (see anchors.ts). One clock, so what a test steps forward moves both.
   */
  now?: () => Date
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * How many rows past the cap a `jira-jql` window asks for.
 *
 * The cursor boundary is INCLUSIVE (scopeResolver.ts), so every window after the first re-contains
 * the items sharing the last attempted item's timestamp — at minimum the last item of the previous
 * run. Asking Jira for exactly `maxItemsPerRun` would spend those slots on keys `selectJqlItems`
 * then filters out, so a run would do less than a full run's work; at `maxItemsPerRun: 1` it
 * STARVES outright — a second ticket sharing the boundary timestamp could never enter the window,
 * because the one already attempted fills it on every future run, forever. Over-fetching is what
 * makes items.ts's "filtered BEFORE the cap, so a run still does a full run's worth of new work"
 * true rather than aspirational, and it is also what makes the reported carry-over count NON-ZERO
 * for jira scopes at all — NOT what makes it real. `deferred` only ever reflects however many of
 * these `max + CURSOR_BOUNDARY_SLACK` over-fetched rows survive the cap after already-attempted
 * keys are filtered out, never the true remainder: at `max: 2` against 100 matching tickets the
 * reported "carried to the next run" count tops out at 10 while 98 tickets actually remain. A
 * caller that needs the true count would have to ask Jira for it separately; nothing here does.
 *
 * Ten bounds the tie: a boundary shared by more than ten ALREADY-ATTEMPTED items would still
 * starve. Paging until the window yields new keys is the complete fix and is deliberately not
 * built here — nothing in the product pages yet, and a bounded over-fetch removes every case
 * anyone has described.
 *
 * "The boundary" is wider than it sounds. This number was chosen when a shared boundary meant an
 * IDENTICAL cursor value — two tickets down to the same instant. It no longer does: the resolver
 * (jiraScopeResolver.ts) formats the cursor through `jiraDate`, which truncates to JQL's own
 * minute resolution (see that function's docblock) — so "the boundary" is now a whole MINUTE-wide
 * bucket, and any tickets filed inside the same minute all share it. Filing more than ten tickets
 * in one minute against a `jira-jql` scope now stalls that routine permanently and silently — a
 * zero-item run is not itself an error, so nothing surfaces it. That is a real, ~60x-wider version
 * of the same accepted risk this constant already documents, not a new one; the mitigation is the
 * same (paging, still deliberately not built) and so is the workaround (a tighter JQL, or accept
 * the manual catch-up).
 */
const CURSOR_BOUNDARY_SLACK = 10

/** One item a scoped run will attempt, as resolution produced it. */
interface ItemTarget {
  /** Jira key, or case slug for a `cases` scope — what `routine_run_items.item_key` records. */
  key: string
  /** What the cursor moves to once this item is attempted. Null for `cases`, which has no
   *  cursor at all (items.ts) — not "no value yet". */
  cursorValue: string | null
  /** The case, when resolution already knows it (`cases` scope). Null when only ingest can
   *  produce it. */
  caseSlug: string | null
}

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
  /** Mirrors `running`: set the instant `execute` begins, cleared alongside it in `drain`'s
   *  `.finally()`. Its `.signal` is threaded into every `runTurn` call this run makes (the main
   *  turn, and each scoped item's turn) — `stopForQuit` calling `.abort()` is what actually
   *  interrupts whichever one is live, via `runBackgroundTurn`'s own signal wiring
   *  (agent/background.ts). Not just a database-relabel: see `stopForQuit`'s docblock. */
  private runningAbort: AbortController | null = null
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
    const runs = listRoutineRuns(this.deps.db)
    const runIds = runs.map((r) => r.id)
    return {
      routines: this.deps.store.list(),
      loadError: this.deps.store.loadError(),
      runningId: this.running?.id ?? null,
      // Re-resolved against the store, same as `drain` does when it actually reaches an entry —
      // a deleted routine's id must drop out of the DISPLAYED queue immediately, not linger
      // until drain gets there and skips it. `drain` also skips a routine that was DISABLED
      // while it waited, but that id is left in `queued` here: the row is still real and still
      // saved, just not currently runnable, so it still belongs on screen until drain resolves it
      // (matching payload() elsewhere, which never hides a disabled routine's row outright).
      queued: this.queue.filter((e) => this.deps.store.get(e.routine.id)).map((e) => e.routine.id),
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
      runs,
      runItems: listRunItems(this.deps.db, runIds),
      unreviewedCount: countUnreviewedRuns(this.deps.db)
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
    forgetRoutineCursor(this.deps.db, id)
  }

  /**
   * Clears one run out of the Home inbox.
   *
   * Thin on purpose: the guard that a live run cannot be marked lives in the SQL (runs.ts), so
   * this stays a write plus an announcement and there is no second place for the rule to drift.
   * The same holds for the refusal to hide un-actioned draft items — runs.ts throws, and the
   * throw reaches the renderer through the IPC handler, which is how the inbox surfaces every
   * other rejected mutation. Nothing is notified on that path because nothing was written.
   */
  markReviewed(runId: number): void {
    markRunReviewed(this.deps.db, runId, this.deps.now)
    this.safeNotify()
  }

  /** Clears the whole inbox, including runs older than the 50 the payload carries. Refuses
   *  (throws, writing nothing) while any unreviewed run still has un-actioned drafts — same
   *  rule, same SQL, as the single-run verb above. */
  markAllReviewed(): void {
    markAllRunsReviewed(this.deps.db, this.deps.now)
    this.safeNotify()
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
        this.runningAbort = null
        this.safeNotify()
        // Serial continuation. Not stack recursion — this runs on a microtask.
        this.drain()
      })
  }

  /**
   * Resolves when nothing is running AND the queue is empty.
   *
   * NOTHING IN PRODUCTION CALLS THIS. The callers are the tests, and any future host that needs
   * to wait for the queue to empty. `before-quit` deliberately does not — it calls `stopForQuit`
   * instead, which returns synchronously and never awaits `this.current`, even though
   * `stopForQuit` DOES trigger the live turn's own teardown (see its docblock: it interrupts the
   * driver via the same seam a timeout uses). Awaiting that teardown here would still block quit
   * on however long the driver actually takes to exit — up to MAX_TIMEOUT_MINUTES in the worst
   * case, the very hang this design has always avoided. Do not read the widening below as quit
   * protecting a run in flight, and do not read `stopForQuit` as this method's synchronous
   * cousin — the two do not compose.
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

  /**
   * Interrupts whatever routine is CURRENTLY RUNNING, and drops the pending queue.
   *
   * ACTUALLY INTERRUPTS THE LIVE TURN — `runningAbort.abort()` fires the `AbortSignal` threaded
   * into every `runTurn` call this run makes (the main turn in `execute`, and each scoped item's
   * turn in `runItemTurn`). `runBackgroundTurn` (agent/background.ts) reacts to it exactly the
   * way it reacts to its OWN timeout: `settle()` still runs `session.stop('stopped')`, which
   * interrupts the live driver and tears the session down. This is not a softer, database-only
   * stop, and it is not new cancellation machinery either — it reuses the interrupt path a
   * timeout already exercises on every routine run; see `enqueue`'s docblock for what is still
   * genuinely absent (a user-facing cancel button while a run is mid-flight and healthy).
   *
   * SYNCHRONOUS ITSELF, AND NEVER AWAITS THE TEARDOWN IT STARTS. `AbortController.abort()` only
   * flips the signal and invokes listeners synchronously; `session.stop()` is async, so the
   * actual teardown — and the `finishRoutineRun` call that eventually closes the row, through the
   * SAME path every other run finishes through (`execute`'s own, not a second writer here) —
   * happens on its own time, after this method has already returned. See `whenIdle`'s docblock
   * for why the quit path must never block on that.
   *
   * WRITES NOTHING TO THE DATABASE ITSELF, and does not need to. A row left `running` because
   * the teardown above didn't finish before the process died is not a user-visible bug: the
   * startup backstop in runs.ts reconciles it at the NEXT launch before the first routine-run IPC
   * handler is even registered, so no renderer can ever observe the stranded state (see that
   * function's own docblock). Writing here too would only race the SAME row against whichever of
   * the two finishes last.
   */
  stopForQuit(): void {
    this.queue = []
    this.runningAbort?.abort()
  }

  private async execute(routine: RoutineDef, trigger: RoutineTrigger): Promise<void> {
    const { db, argusHome } = this.deps
    const slug = `routine-${routine.id}`
    // Opened before any fallible work so a setup failure is a recorded `failed` run rather than
    // an invisible no-op. routine_runs has no FK to cases (db.ts), so the row is legal even if
    // the case is never created.
    //
    // NULL for a scoped run, not `slug`: a scoped run never creates a `routine-<id>` case (see
    // the branch below) — its items open their OWN cases, recorded on routine_run_items. Writing
    // `slug` here regardless was Finding 2's bug: the run row claimed a case that was never
    // created, and RoutineInbox's "Open case" button took the user to a 404.
    const runId = insertRoutineRun(
      db,
      routine.id,
      routine.scope ? null : slug,
      trigger,
      this.deps.now
    )
    // Mirrors `running` (set by `drain` just before this call). `.signal` is threaded into every
    // `runTurn` call this run makes below — `stopForQuit` aborting it is what actually reaches
    // and interrupts whichever turn is live.
    this.runningAbort = new AbortController()
    this.safeNotify()

    // One decision, two consumers: the session row below and the turn request further down.
    // Deriving it twice is how the recorded driver and the executing driver drift apart.
    const driverKind = routine.driverKind ?? 'claude-agent-sdk'

    // Branched HERE, before anything below has run, so the unscoped path is byte-for-byte the
    // increment-2 path it has been live-verified as. A scoped run creates no `routine-<id>` case
    // and no run-level session; an unscoped run opens no item row. Nothing is shared but the run
    // row above and the preamble.
    if (routine.scope) {
      await this.executeItems(routine, routine.scope, runId, driverKind)
      return
    }

    let result: BackgroundTurnResult
    try {
      const rec =
        getCase(db, slug) ?? createCase(db, argusHome, { slug, title: `Routine: ${routine.name}` })
      // After get-or-create, not inside createCase: this run may be ADOPTING a case an
      // increment-1 run created before the column existed, in which case createCase never ran.
      ensureCaseOrigin(db, slug, 'routine')
      const session = createSession(db, slug, {
        driverKind,
        model: routine.model ?? null
      })
      attachRunSession(db, runId, session.id)
      // Announce promptly: without this, every payload() consumer sees a `running` row whose
      // sessionId is still null for the entire run (up to timeoutMs), unable to link the row to
      // the live agent session while it's actually running — exactly when that link matters.
      this.safeNotify()

      const preamble = this.unattendedPreamble(routine)

      result = await this.deps.runTurn({
        caseId: rec.id,
        caseSlug: slug,
        sessionId: session.id,
        driverKind,
        prompt: preamble + routine.prompt,
        timeoutMs: routine.timeoutMs,
        // Present even though `stopForQuit` only ever aborts the CURRENT run's controller —
        // `runningAbort` is reassigned fresh per run (above), so a signal captured here can
        // never be fired by some LATER run's stop.
        signal: this.runningAbort?.signal,
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

    // Swallowed and logged for exactly the reason safeNotify is (see its contract above): this
    // sits in the queue's control flow, and an escaping throw would skip drain()'s continuation
    // and stall every pending run. Losing one notification beats stalling the engine.
    try {
      this.deps.onRunFinished?.({
        runId,
        routineId: routine.id,
        routineName: routine.name,
        status: result.status,
        ...(result.text ? { summary: result.text } : {}),
        ...(result.error ? { error: result.error } : {})
      })
    } catch (err) {
      console.error('[routines] onRunFinished failed:', message(err))
    }
  }

  /**
   * The unattended identity and freshness watermark both paths prepend to a routine's prompt.
   *
   * Read when the run EXECUTES, not when it was queued: a run that waited behind another must see
   * the watermark as it stands when IT starts. Read once per run rather than once per item — the
   * run in flight cannot change its own `lastSuccessAt`, so a per-item read would return the same
   * string N times while implying it might not.
   */
  private unattendedPreamble(routine: RoutineDef): string {
    const since = lastSuccessAt(this.deps.db, routine.id)
    const watermark = since
      ? `Your last successful run of this routine finished at ${since}. Concentrate on what ` +
        `has changed since then.`
      : `This is the first run of this routine — there is no previous run to compare against.`

    return (
      `You are running unattended as the routine "${routine.name}". No user is present: ` +
      `never ask questions, make reasonable assumptions, note anything that needs human ` +
      `review, and end with a concise summary of what you did and found.\n\n` +
      `${watermark}\n\n`
    )
  }

  /**
   * One turn per item, serially.
   *
   * THE CURSOR ADVANCES OVER ATTEMPTED ITEMS, INCLUDING FAILED AND SKIPPED ONES, AND NEVER OVER
   * CAPPED ONES. A deliberate deviation from the parent spec's "advanced only for items actually
   * processed", which exists to stop a capped run dropping its tail. Capping and failing are
   * different: a capped item was never looked at, a failed one was. Holding the cursor on a
   * failure makes one permanently-bad ticket the first item of every future run, forever, with
   * nothing behind it ever reached — while the run still reports success on everything else.
   *
   * PER-ITEM FAILURES NEVER KILL THE RUN. Each item has its own try/catch that closes its row as
   * `failed`; only a failure to resolve the scope AT ALL, or a failure of the bookkeeping itself
   * (the per-item DB writes below), reaches the outer catch. The first of those produces no items
   * at all; the second can fire mid-loop with items already processed behind it — the outer catch
   * reports the run failed either way, but keeps whatever processed/skipped/failed counts the
   * loop had already earned rather than discarding them.
   */
  private async executeItems(
    routine: RoutineDef,
    scope: RoutineScope,
    runId: number,
    driverKind: string
  ): Promise<void> {
    const { db } = this.deps
    // Defaulted HERE and not in the schema, so an unscoped routine's parsed shape stays exactly
    // what increment 2 produced (shared/routines.ts).
    const max = routine.maxItemsPerRun ?? DEFAULT_ITEMS_PER_RUN
    const resolver = this.deps.scopeResolver

    let processed = 0
    let failed = 0
    let skipped = 0
    let deferred = 0

    // Closes over the counters above, read at whichever point the run finishes — the happy path
    // at the bottom of this function, or the outer catch when the loop aborts mid-run. One
    // function so the two call sites cannot format the same numbers two different ways.
    const summarize = (): string => {
      const parts = [`${processed} processed`]
      if (skipped) parts.push(`${skipped} skipped`)
      if (failed) parts.push(`${failed} failed`)
      if (deferred) parts.push(`${deferred} carried to the next run`)
      return parts.join(' · ')
    }

    try {
      if (!resolver) {
        throw new Error('No scope resolver is bound; this host cannot run scoped routines')
      }

      const targets = await this.resolveTargets(routine, scope, resolver, max)
      deferred = targets.deferred
      const preamble = this.unattendedPreamble(routine)

      for (const target of targets.selected) {
        // Checked BEFORE opening a row for this item, not after: an item this loop never
        // reaches because quit already aborted the run stays fully unattempted (no row, cursor
        // untouched), same as one this run's cap never got to — rather than opening a row just
        // to immediately fail it. The item ALREADY mid-turn when `stopForQuit` fires is not
        // caught by this guard; its own `runTurn` call sees the same signal and is what actually
        // stops it (see `execute`/`runItemTurn`).
        if (this.runningAbort?.signal.aborted) break
        const itemId = insertRunItem(db, runId, target.key, this.deps.now)
        this.safeNotify()
        try {
          const caseSlug = await this.materializeItem(target, itemId, resolver)
          if (getCase(db, caseSlug)?.reviewState === 'draft') {
            // Already produced a draft nobody has acted on. A second one is noise, and a backlog
            // of ignored drafts would otherwise consume every run's cap forever so no new item is
            // ever reached. A skip is a REAL attempt: it consumes a slot and moves the cursor,
            // because the alternative is a run that silently does more work than its cap allows.
            finishRunItem(db, itemId, { status: 'skipped' }, this.deps.now)
            skipped++
          } else {
            await this.runItemTurn({
              routine,
              target,
              caseSlug,
              itemId,
              runId,
              driverKind,
              preamble
            })
            // Ordered after the turn: a case is only a draft once there is something to review.
            setCaseReviewState(db, caseSlug, 'draft')
            finishRunItem(db, itemId, { status: 'processed' }, this.deps.now)
            processed++
          }
        } catch (err) {
          // Ingest threw, or the turn did not come back `ok`. Nothing distinguishes the two in
          // the schema because nothing acts on the distinction — the error text does.
          finishRunItem(db, itemId, { status: 'failed', error: message(err) }, this.deps.now)
          failed++
        }
        // OUTSIDE the per-item catch, and inside the loop. Outside, because the cursor tracks
        // what was ATTEMPTED. Inside, because a run capped at 10 of 40 must resume at item 11 and
        // a crash at item 7 must not replay items 1-6.
        if (target.cursorValue !== null) {
          writeRoutineCursor(db, routine.id, target.cursorValue, this.deps.now)
        }
        this.safeNotify()
      }
    } catch (err) {
      // Reached either by scope resolution failing outright (no items were ever produced) or by
      // the per-item bookkeeping itself failing mid-loop (the abort test drives exactly this: an
      // item already `processed` behind the one that aborted). Either way the RUN is failed, but
      // a run that completed 6 of 8 items before dying must still say so — summarize() below
      // reports whatever processed/skipped/failed the loop had already earned, not nothing.
      // Nothing was ever attempted when the loop never opened an item row at all — scope
      // resolution failing outright is the common case, but a bookkeeping write can also throw
      // before the very first item completes. Either way `summarize()` would report only
      // "0 processed", which reads as a run that did something rather than one that couldn't
      // start; omit it so the inbox shows the error alone.
      const attempted = processed > 0 || skipped > 0 || failed > 0
      finishRoutineRun(
        db,
        runId,
        {
          status: 'failed',
          error: message(err),
          ...(attempted ? { summary: summarize() } : {})
        },
        this.deps.now
      )
      return
    }

    // Checked AFTER the loop, not just inside its own guard — the loop's `break` only covers
    // quit landing WHILE an item is being attempted (or between items). Quit can just as easily
    // land during `resolveTargets` above (a real, seconds-wide Jira query the abort signal is
    // not wired into at all), in which case the loop above never even runs once: `processed` and
    // `failed` both stay zero, and the OLD `processed === 0 && failed > 0 ? 'failed' : 'ok'`
    // read that as a clean `ok`. Either shape — cut short mid-item, or cut short before the
    // first item — means this run did NOT finish on its own terms and must never read `ok`:
    // `lastSuccessAt` (runs.ts) only advances on `status='ok'`, and moving it here would tell
    // the NEXT run "nothing has changed since" work that, for whatever this run never reached,
    // in fact never happened — exactly what `lastSuccessAt`'s own docblock forbids.
    if (this.runningAbort?.signal.aborted) {
      const attempted = processed > 0 || skipped > 0 || failed > 0
      finishRoutineRun(
        db,
        runId,
        {
          status: 'failed',
          error: TURN_ABORTED_ERROR,
          // Distinguishes "cut short by quit, but did real work first" from a run that failed
          // outright — summarize() alone (e.g. "1 processed · 1 failed") reads as an ordinary
          // mixed-outcome run with nothing to explain why item 3 is simply absent.
          ...(attempted ? { summary: `${summarize()} · stopped: the app was quitting` } : {})
        },
        this.deps.now
      )
      return
    }

    finishRoutineRun(
      db,
      runId,
      // A run where every item failed is a failed run — no new rule needed for the inbox, which
      // already shows failures.
      { status: processed === 0 && failed > 0 ? 'failed' : 'ok', summary: summarize() },
      this.deps.now
    )
  }

  /**
   * The scope's items, capped, with the remainder counted rather than dropped.
   *
   * The two branches differ in more than their source: `jira-jql` is a remote query bounded by a
   * persisted cursor and de-duplicated by key, while `cases` is a local predicate with no cursor
   * at all (items.ts explains why a cursor would be actively wrong for a sweep).
   */
  private async resolveTargets(
    routine: RoutineDef,
    scope: RoutineScope,
    resolver: ScopeResolver,
    max: number
  ): Promise<Selection<ItemTarget>> {
    const { db } = this.deps

    if (scope.kind === 'jira-jql') {
      const resolved = await resolver.resolveJql(
        scope.jql,
        scope.cursorField,
        readRoutineCursor(db, routine.id),
        max + CURSOR_BOUNDARY_SLACK
      )
      const sel = selectJqlItems(resolved, attemptedItemKeys(db, routine.id), max)
      return {
        selected: sel.selected.map((i) => ({
          key: i.key,
          cursorValue: i.cursorValue,
          caseSlug: null
        })),
        deferred: sel.deferred
      }
    }

    const sel = selectCaseItems(resolveCaseCandidates(db, routine.id, scope, this.deps.now), max)
    return {
      selected: sel.selected.map((c) => ({
        key: c.slug,
        cursorValue: null,
        caseSlug: c.slug
      })),
      deferred: sel.deferred
    }
  }

  /**
   * Gets the item's case onto disk and bound to its item row, and returns its slug.
   *
   * `ingestJiraItem` CREATES OR ADOPTS (scopeResolver.ts), so re-ingesting a ticket that already
   * has a case is the normal path, not an error — it is how the draft check below ever sees a
   * draft, and how a ticket the user already opened by hand is worked in place rather than
   * duplicated.
   *
   * `ensureCaseOrigin` runs on the jira branch only, and only when `created` is true. A
   * `cases`-scoped item was SELECTED FROM the cases table, so it demonstrably predates this run.
   * On the jira branch, `ingestJiraItem` ADOPTS an existing case when the ticket already has one
   * (scopeResolver.ts) — `created: false` in that case — and stamping an adopted case `routine`
   * would relabel a case the user opened by hand as routine-created, exactly the same mistake the
   * `cases` branch avoids, just reached through the ingest path instead of selection (Task 11
   * review finding).
   */
  private async materializeItem(
    target: ItemTarget,
    itemId: number,
    resolver: ScopeResolver
  ): Promise<string> {
    const { db } = this.deps
    if (target.caseSlug) {
      attachItemCase(db, itemId, target.caseSlug)
      return target.caseSlug
    }
    const { caseSlug, created } = await resolver.ingestJiraItem(target.key)
    attachItemCase(db, itemId, caseSlug)
    if (created) ensureCaseOrigin(db, caseSlug, 'routine')
    return caseSlug
  }

  /**
   * One unattended turn against one item's case.
   *
   * `runItemId` IS THE POINT. It is what `propose_case_triage` is gated on: the tool is advertised
   * only to a session constructed with that thunk, and refuses without an id even then
   * (nativeTools.ts). Without this field the whole suggestion half of the feature is unreachable
   * while every unit test still passes, because each end of the chain is testable alone.
   *
   * A turn that does not come back `ok` THROWS, so the caller's per-item catch records the item
   * `failed`. Returning normally would leave a timed-out item indistinguishable from a processed
   * one, and would mark its case a draft with nothing in it to review.
   */
  private async runItemTurn(args: {
    routine: RoutineDef
    target: ItemTarget
    caseSlug: string
    itemId: number
    runId: number
    driverKind: string
    preamble: string
  }): Promise<void> {
    const { db } = this.deps
    const { routine, target, caseSlug, itemId, runId, driverKind, preamble } = args

    const rec = getCase(db, caseSlug)
    if (!rec) throw new Error(`Item ${target.key} produced no case (${caseSlug})`)

    const session = createSession(db, caseSlug, { driverKind, model: routine.model ?? null })
    // The run row carries ONE session id and a scoped run has one session per item, so this
    // tracks the item in flight. That is the useful answer while the run is live — the per-item
    // audit trail is `routine_run_items`, which is where an item's own history belongs.
    attachRunSession(db, runId, session.id)
    this.safeNotify()

    const itemPreamble =
      `You are processing item ${target.key} of this routine's scope; this case is that item. ` +
      `Propose a title or tags for it with propose_case_triage rather than editing the case ` +
      `yourself — a human reviews every suggestion before any of it is applied.\n\n`

    const result = await this.deps.runTurn({
      caseId: rec.id,
      caseSlug,
      sessionId: session.id,
      runItemId: itemId,
      driverKind,
      prompt: preamble + itemPreamble + routine.prompt,
      timeoutMs: routine.timeoutMs,
      // Same seam as the unscoped turn in `execute` — one `runningAbort` per run, shared across
      // every item's turn, so `stopForQuit` reaches whichever item is currently live.
      signal: this.runningAbort?.signal,
      ...(routine.model ? { model: routine.model } : {})
    })
    if (result.status !== 'ok') {
      throw new Error(result.error ?? `turn ended: ${result.status}`)
    }
  }

  /**
   * Promotes a draft: applies the suggestion, then clears the draft flag.
   *
   * ORDERED, not transactional, and the order is the guarantee. `setCaseTriage` writes the row AND
   * mirrors case.json, so no SQL transaction could cover both halves anyway; doing it before the
   * flag is cleared means a failure leaves the case still a draft, still in the inbox, and still
   * acceptable — whereas the reverse would drop a case out of review with the suggestion never
   * applied and no trace that it was meant to be.
   *
   * Reads the item's CURRENT state rather than trusting the renderer, so a second window that
   * already accepted it re-applies the same values instead of double-applying different ones.
   */
  acceptItem(itemId: number): void {
    const item = getRunItem(this.deps.db, itemId)
    if (!item?.caseSlug) return
    const s = item.suggestion
    if (s && (s.title || s.tags)) {
      setCaseTriage(this.deps.db, this.deps.argusHome, item.caseSlug, {
        ...(s.title ? { title: s.title } : {}),
        ...(s.tags ? { tags: s.tags } : {})
      })
    }
    // Unconditional: an item whose turn proposed nothing is still a draft a human has now read,
    // and leaving it flagged would keep it in the inbox with no verb that can clear it.
    setCaseReviewState(this.deps.db, item.caseSlug, null)
    this.safeNotify()
  }

  /**
   * Closes the draft's case.
   *
   * `review_state` STAYS SET on purpose, so a dismissed draft remains distinguishable from a case
   * that was never one. The already-closed guard makes a second window's dismissal a no-op rather
   * than a second close with a different resolution.
   */
  dismissItem(itemId: number, resolution: CaseResolution): void {
    const item = getRunItem(this.deps.db, itemId)
    if (!item?.caseSlug) return
    const kase = getCase(this.deps.db, item.caseSlug)
    if (kase && kase.status !== 'closed') {
      setCaseStatus(this.deps.db, this.deps.argusHome, item.caseSlug, 'closed', resolution)
    }
    this.safeNotify()
  }
}
