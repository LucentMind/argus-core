import { spawnSync } from 'node:child_process'
import type { AgentDriver } from './driver'
import { DRIVERS } from './driverRegistry'
import { resolveCopilotCliPath } from './drivers/copilot/client'
import { claudeBinaryPath } from './drivers/claude/cliPath'

/**
 * Packaged-build smoke check: can every driver's bundled CLI actually be spawned?
 *
 * This exists because two providers shipped broken in a row for the same reason — their
 * binaries resolved to a path inside `app.asar`, which Electron virtualizes for `fs` but not
 * for process spawning (see `drivers/asar.ts`). Nothing in the unit suite can catch that:
 * there is no asar until the app is packaged, so everything is green while the shipped app is
 * dead. Only a check that runs against a real packaged build closes the gap.
 *
 * Two layers, and only the first one gates:
 *
 *  1. `checkDriverBinaries` spawns each resolved binary with `--version`. This is the CI gate:
 *     it answers "can this be launched?" directly and needs no credentials.
 *  2. `runProviderSmoke` runs each driver's real auth probe. Richer — it exercises the whole
 *     driver path — but its verdicts depend on being logged in, so it is reported for humans
 *     and never fails the build. An earlier version of this file gated on the probes and would
 *     have failed every CI run: with no credentials the Claude probe reports 'claude CLI
 *     exited before initializing', which is indistinguishable from a real launch failure by
 *     message alone.
 */

/** Each driver kind mapped to its bundled binary, or null when it cannot be resolved. */
export function driverBinaries(): Record<string, string | null> {
  return {
    'claude-agent-sdk': claudeBinaryPath(),
    'github-copilot': resolveCopilotCliPath()
  }
}

export interface SpawnResultLike {
  status: number | null
  error?: Error
  stdout: string
}

type SpawnFn = (bin: string, args: string[]) => SpawnResultLike

const defaultSpawn: SpawnFn = (bin, args) => {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 60_000 })
  return { status: r.status, ...(r.error ? { error: r.error } : {}), stdout: r.stdout ?? '' }
}

/**
 * The gate: spawn every driver's binary with `--version`. Exit 0 means it launched; anything
 * else — ENOENT, non-zero exit, or a path we could not resolve at all — is a packaging bug.
 */
export function checkDriverBinaries(
  binaries: Record<string, string | null> = driverBinaries(),
  spawn: SpawnFn = defaultSpawn
): { ok: boolean; results: SmokeResult[] } {
  const results: SmokeResult[] = []
  for (const [kind, bin] of Object.entries(binaries)) {
    if (!bin) {
      results.push({ kind, launched: false, detail: 'binary path could not be resolved' })
      continue
    }
    const r = spawn(bin, ['--version'])
    const launched = !r.error && r.status === 0
    results.push({
      kind,
      launched,
      detail: launched
        ? `${r.stdout.trim().split('\n')[0]} — ${bin}`
        : (r.error?.message ?? `exited ${r.status} — ${bin}`)
    })
  }
  return { ok: results.every((r) => r.launched), results }
}

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
