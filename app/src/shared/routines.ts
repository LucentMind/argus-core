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

export interface RoutineRunSummary {
  id: number
  routineId: string
  caseSlug: string
  sessionId: number | null
  status: 'running' | 'ok' | 'failed' | 'timeout'
  startedAt: string
  finishedAt: string | null
  /** Final assistant text of the run's single turn. */
  summary: string | null
  error: string | null
}

export interface RoutinesPayload {
  routines: RoutineDef[]
  loadError: string | null
  /** Routine id currently executing, or null. Runs are serial. */
  runningId: string | null
  runs: RoutineRunSummary[]
}
