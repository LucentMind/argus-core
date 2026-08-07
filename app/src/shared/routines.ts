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
export const routineSchema = z.looseObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,55}$/),
  name: z.string().min(1),
  prompt: z.string().min(1),
  /** Driver kind (driverRegistry key). Absent = 'claude-agent-sdk'. */
  driverKind: z.string().optional(),
  /** Model slug for the driver. Absent = driver default. */
  model: z.string().optional(),
  timeoutMs: z.number().int().positive().default(600_000),
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
