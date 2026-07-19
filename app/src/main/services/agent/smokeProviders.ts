import type { AgentDriver } from './driver'
import { DRIVERS } from './driverRegistry'

/**
 * Packaged-build smoke check: can every driver's bundled CLI actually be spawned?
 *
 * This exists because two providers shipped broken in a row for the same reason — their
 * binaries resolved to a path inside `app.asar`, which Electron virtualizes for `fs` but not
 * for process spawning (see `drivers/asar.ts`). Nothing in the unit suite can catch that:
 * there is no asar until the app is packaged, so everything is green while the shipped app is
 * dead. Only a check that runs against a real packaged build closes the gap.
 *
 * The assertion is deliberately narrow: the binary *launched*. Authentication is explicitly
 * NOT asserted — CI has no credentials, and "not authenticated" is a healthy answer that
 * proves the process ran and answered. Widening this to require auth would make the check
 * unrunnable in CI, which is the same as not having it.
 */

/**
 * Failure details that still prove the binary ran: it started, talked to us, and told us it
 * has no credentials. Everything else counts as "did not launch".
 *
 * This is an allowlist on purpose. The first version of this check denylisted known failure
 * phrases, and scored Copilot's `ERR_STREAM_DESTROYED` teardown message as a successful
 * launch — a Copilot-only regression would have sailed through the gate. Failing closed means
 * a new, unrecognized error breaks the build and someone looks at it, which is the point.
 */
const AUTHENTICATION_VERDICT = [
  /not authenticated/i,
  /not logged in/i,
  /\blog ?in\b/i,
  /\/login\b/i,
  /ANTHROPIC_API_KEY/i,
  /invalid api key/i
]

export interface ProbeLike {
  ok: boolean
  detail?: string
}

export interface SmokeVerdict {
  launched: boolean
  detail: string
}

/** Classify one probe result (or a thrown error) as "the binary launched" or not. */
export function classifyProbe(result: ProbeLike | unknown): SmokeVerdict {
  if (result instanceof Error) return { launched: false, detail: result.message }
  const probe = result as ProbeLike
  const detail = probe?.detail ?? (probe?.ok ? 'ok' : 'no detail')
  if (probe?.ok) return { launched: true, detail }
  return { launched: AUTHENTICATION_VERDICT.some((re) => re.test(detail)), detail }
}

export interface SmokeResult {
  kind: string
  launched: boolean
  detail: string
}

export async function runProviderSmoke(
  drivers: Record<string, AgentDriver> = DRIVERS,
  timeoutMs = 30000
): Promise<{ ok: boolean; results: SmokeResult[] }> {
  const results: SmokeResult[] = []
  for (const [kind, driver] of Object.entries(drivers)) {
    const verdict = await driver
      .probeAuth({ timeoutMs })
      .then((r) => classifyProbe(r))
      .catch((err) => classifyProbe(err instanceof Error ? err : new Error(String(err))))
    results.push({ kind, ...verdict })
  }
  return { ok: results.every((r) => r.launched), results }
}
