import type { DatabaseSync } from 'node:sqlite'
import type { PromptTextSpecs } from '../../../shared/promptSpec'
import type { PrCheck } from '../../../shared/prStatus'
import type { Detection } from '../packs/detection'
import { fillPrompt } from '../prompts/fill'
import { getBinding } from '../prBindings'
import { ingestContent } from '../ingest'
import { defaultGhRunner, fetchJobLog, fetchPrStatuses, prTargetKey, type Runner } from '../github'

/** A build log is routinely megabytes. Past this we keep the TAIL — where a failure lands. */
export const CI_LOG_MAX_BYTES = 2 * 1024 * 1024

export const CI_LOG_FEEDBACK: PromptTextSpecs = {
  'ci_logs.no-binding': {
    title: 'ci logs — no pull request bound',
    text: 'No pull request is bound to this case, so there are no checks to read.'
  },
  'ci_logs.unknown-check': {
    title: 'ci logs — no such check',
    text: 'No check named "{name}" on this pull request. Available checks: {available}.',
    placeholders: ['name', 'available']
  },
  'ci_logs.not-actions': {
    title: 'ci logs — check is not a GitHub Actions job',
    text: 'Check "{name}" is not a GitHub Actions job, so Argus cannot read its log. Open {url} to see it.',
    placeholders: ['name', 'url']
  },
  'ci_logs.unavailable': {
    title: 'ci logs — pull request could not be read',
    text: 'Could not read this pull request: {error}',
    placeholders: ['error']
  },
  'ci_logs.ok': {
    title: 'ci logs — fetched',
    text: 'Fetched the log for "{name}" as evidence_id {id}, stored at {path}. Read it with read_lines or grep_lines — do not paste it back in full. Cite lines from it as [{path}:<line>] — that exact path prefix, not the evidence_id.',
    placeholders: ['name', 'id', 'path']
  }
}

export interface CiLogDeps {
  db: DatabaseSync
  argusHome: string
  detection: Detection
  gh?: Runner
  resolve?: (id: string) => string
}

/** Resolve one feedback string, filled. Exported because the `fetch_check_logs` handler in
 *  `nativeTools.ts` returns the success text and must resolve it through the same registry
 *  seam, not hardcode a second copy of the sentence. */
export function ciFeedback(
  deps: Pick<CiLogDeps, 'resolve'>,
  key: string,
  vars: Record<string, string> = {}
): string {
  const text = deps.resolve ? deps.resolve(`tool-feedback.${key}`) : CI_LOG_FEEDBACK[key].text
  return fillPrompt(text, vars)
}

const cf = ciFeedback

/**
 * Pick which of several same-named checks the caller meant.
 *
 * Check names are not unique on a real pull request — the Task 1 capture found one PR listing
 * "Semantic Pull Request" twice and another with 46 contexts under 20 distinct names, each a
 * separate run with its own job id and its own verdict. A bare `.find()` would hand back
 * whichever came first, so "why did build fail?" could fetch a *passing* build's log. Prefer a
 * failing run with a readable job id, then any run with one, then the first match at all (so the
 * "not a GitHub Actions job" message still fires for a name that only has unreadable runs).
 */
function pickCheck(checks: PrCheck[], wanted: string): PrCheck | undefined {
  const matches = checks.filter((c) => c.name.toLowerCase() === wanted)
  return (
    matches.find((c) => c.bucket === 'fail' && c.jobId !== null) ??
    matches.find((c) => c.jobId !== null) ??
    matches[0]
  )
}

/**
 * Pull a named check's GitHub Actions job log and ingest it as case evidence (spec §7:
 * "CI-failure analysis = triage on CI logs" — the log becomes ordinary evidence so the existing
 * evidence + findings machinery does the rest, and review mode gets root-cause analysis for
 * free).
 *
 * Resolution is by NAME against a LIVE fetch, not against the cache and not by job id (design
 * decision 9): the agent is told check names in the composed prompt and can also be asked for
 * one in chat, and a cache that is a minute old could send it after a job that has since been
 * re-run. A non-Actions check is refused rather than attempted — `actionsJobId` returning null
 * is the whole rule (design decision 8).
 */
export async function fetchCheckLogs(
  deps: CiLogDeps,
  caseSlug: string,
  checkName: string
): Promise<{ evidenceId: number; relPath: string; text: string }> {
  const binding = getBinding(deps.db, caseSlug)
  if (!binding) throw new Error(cf(deps, 'ci_logs.no-binding'))

  const target = { owner: binding.owner, repo: binding.repo, number: binding.number }
  const run = deps.gh ?? defaultGhRunner
  const status = (await fetchPrStatuses(run, [target], new Date().toISOString())).get(
    prTargetKey(target)
  )!
  if (status.rollup === 'unavailable') {
    throw new Error(cf(deps, 'ci_logs.unavailable', { error: status.error ?? 'unknown error' }))
  }

  const wanted = checkName.trim().toLowerCase()
  const check = pickCheck(status.checks, wanted)
  if (!check) {
    throw new Error(
      cf(deps, 'ci_logs.unknown-check', {
        name: checkName,
        // De-duplicated: listing "build, build, build, lint" back at the model would read as
        // four different checks.
        available: [...new Set(status.checks.map((c) => c.name))].join(', ') || '(none)'
      })
    )
  }
  if (check.jobId === null) {
    throw new Error(
      cf(deps, 'ci_logs.not-actions', { name: check.name, url: check.url ?? status.url })
    )
  }

  const repo = `${binding.owner}/${binding.repo}`
  let text = await fetchJobLog(run, repo, check.jobId)
  if (text.length > CI_LOG_MAX_BYTES) {
    // Keep the tail: a job log's failure is at the end, and a head-truncated log would ingest
    // the setup steps and drop the error the whole fetch exists to find.
    text = `[truncated: kept the last ${CI_LOG_MAX_BYTES} of ${text.length} characters]\n${text.slice(-CI_LOG_MAX_BYTES)}`
  }

  const safeName = check.name.replace(/[^A-Za-z0-9._-]+/g, '-')
  const rec = ingestContent(
    deps.db,
    deps.argusHome,
    deps.detection,
    caseSlug,
    `ci-${binding.number}-${safeName}.log`,
    text,
    'ci',
    { prNumber: binding.number, checkName: check.name, jobId: check.jobId, url: check.url },
    'review'
  )
  return { evidenceId: rec.id, relPath: rec.relPath, text }
}
