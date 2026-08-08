import { z } from './zodConfig'

/**
 * config/routines.json — user-defined routines (saved prompt + trigger, run unattended).
 *
 * Routine ids are embedded in case slugs as `routine-<id>` (a later task), so this regex
 * must produce only strings that caseService's `SLUG_RE`
 * (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`, max 64 chars total) accepts once prefixed with
 * `routine-` (8 chars). It is deliberately narrower than SLUG_RE on two axes: lowercase-only
 * charset (SLUG_RE also allows uppercase and `.`), and a length cap of 56 so the full slug
 * never exceeds SLUG_RE's 64-char ceiling.
 */
/**
 * Hard ceiling on a routine's turn budget: 2 hours.
 *
 * Increment 1 has NO cancel — once `runBackgroundTurn` arms its timer, the only thing that ends
 * the run early is the turn itself completing. The editor's number input therefore puts a user
 * one keystroke from a run that occupies the (serial) routine slot for the rest of the day.
 * Enforced HERE rather than only in the form so a hand-edited config/routines.json cannot
 * exceed it either. 120 minutes is well past any plausible single unattended turn while still
 * bounding the damage of a typo.
 */
export const MAX_TIMEOUT_MINUTES = 120
export const MAX_TIMEOUT_MS = MAX_TIMEOUT_MINUTES * 60_000

/**
 * Local-time HH:MM, 24-hour. Anchored at both ends so `2:00` and `02:0` are rejected rather
 * than half-parsed — the string is split and fed to `new Date(...)` arithmetic, where a
 * NaN component silently produces an Invalid Date instead of an error.
 */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Floor on `interval` schedules.
 *
 * Not politeness to an API — the engine is SERIAL and a run's timeout can reach
 * MAX_TIMEOUT_MINUTES (120). At one minute, a routine whose turn takes three is due again
 * before it finishes; coalescing stops it stacking, but it holds the single execution slot
 * continuously and starves every other routine behind it.
 *
 * Five rather than fifteen because the scheduler is jsdom-blind and its exit-check must observe
 * two real fires (spec §8). At fifteen that is half an hour of babysitting per attempt, and a
 * verification that painful is a verification that gets skipped.
 */
export const MIN_INTERVAL_MINUTES = 5
/** One week. Past this, `daily`/`weekly` express the intent better and read better in the UI. */
export const MAX_INTERVAL_MINUTES = 10_080

/**
 * When a routine fires. Absent from a routine = manual-only, which is exactly what every
 * increment-1 routine is — so no migration, and a hand-written routines.json stays valid.
 *
 * Times are LOCAL and there is no per-routine timezone: on a desktop app, "nightly 02:00"
 * means the operator's 02:00.
 */
export const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('interval'),
    everyMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(MAX_INTERVAL_MINUTES)
  }),
  z.object({ kind: z.literal('daily'), at: z.string().regex(HHMM) }),
  z.object({
    kind: z.literal('weekly'),
    /** 0 = Sunday … 6 = Saturday, matching `Date.prototype.getDay()`. */
    days: z.array(z.number().int().min(0).max(6)).min(1),
    at: z.string().regex(HHMM)
  })
])
export type RoutineSchedule = z.infer<typeof scheduleSchema>

export const routineSchema = z.looseObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,55}$/),
  name: z.string().min(1),
  prompt: z.string().min(1),
  /** Driver kind (driverRegistry key). Absent = 'claude-agent-sdk'. */
  driverKind: z.string().optional(),
  /** Model slug for the driver. Absent = driver default. */
  model: z.string().optional(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS, `Timeout must be at most ${MAX_TIMEOUT_MINUTES} minutes`)
    .default(600_000),
  /** Absent = manual-only. See scheduleSchema. */
  schedule: scheduleSchema.optional(),
  enabled: z.boolean().default(true)
})
export type RoutineDef = z.infer<typeof routineSchema>

export const routinesFileSchema = z.looseObject({
  routines: z.array(routineSchema).default(() => [])
})
export type RoutinesFile = z.infer<typeof routinesFileSchema>

export function defaultRoutines(): RoutinesFile {
  return routinesFileSchema.parse({})
}

// — cross-process payloads —

/** What started a run. `catchup` is a scheduled fire the app was closed for. */
export type RoutineTrigger = 'manual' | 'scheduled' | 'catchup'

export interface RoutineRunSummary {
  id: number
  routineId: string
  caseSlug: string
  sessionId: number | null
  trigger: RoutineTrigger
  status: 'running' | 'ok' | 'failed' | 'timeout'
  startedAt: string
  finishedAt: string | null
  /** Final assistant text of the run's single turn. */
  summary: string | null
  error: string | null
  /** When a human cleared this run from the Home inbox; null = still unreviewed. */
  reviewedAt: string | null
}

export interface RoutinesPayload {
  routines: RoutineDef[]
  loadError: string | null
  /** Routine id currently executing, or null. Runs are serial. */
  runningId: string | null
  /** Routine ids waiting for the execution slot, in the order they will run. */
  queued: string[]
  /** Derived next fire per routine id; null = manual-only or disabled. */
  nextRunAt: Record<string, string | null>
  runs: RoutineRunSummary[]
  /** Finished runs waiting to be reviewed. A SQL count, not `runs.filter(...)`: `runs` is
   *  capped at 50 and would under-report a large backlog. */
  unreviewedCount: number
}
