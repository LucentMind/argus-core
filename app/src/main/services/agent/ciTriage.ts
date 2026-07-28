import { fillPrompt } from '../prompts/fill'
import type { PromptTextSpecs } from '../../../shared/promptSpec'

/**
 * The turn the companion's Analyze button sends. Composed in main (which owns the binding and
 * the worktree path) and delivered through the ordinary `agent.send`, so cancel, queue and
 * mirror behave exactly as they do for a typed message — the shape Plan 3's review run and Plan
 * 4's write actions established.
 *
 * Deliberately NOT a `ReviewAction`: every one of those resolves a finding, and this turn's
 * whole purpose is to produce the first one (design decision 10).
 */
export const CI_TRIAGE_PROMPTS: PromptTextSpecs = {
  analyze: {
    title: 'Review action — analyze a CI failure',
    text: `The CI check "{checkName}" is failing on {prUrl}. Find out why.

1. Call fetch_check_logs with check_name "{checkName}". It pulls the job's log into this case as
   evidence and returns an evidence_id. Read the log with read_lines and grep_lines — it can be
   very large, so search it rather than reading it end to end, and never quote it back in full.
2. Find the FIRST real error, not the last line of output. A build log's tail is usually the
   runner tearing down; the cause is above it.
3. {worktreeLine}
4. Call append_finding with a severity and a citation to the evidence line the failure is on.
   Leave layer unset — this is a CI failure, not one of the diff-review layers. If the failure is
   in the pull request's own code, cite that code as well, using [<repo-name>/<path>:<line>].
5. If the log shows the failure is unrelated to this pull request (a flaky test, an infrastructure
   error, a dependency outage), say so and record it as a minor finding. Do not invent a code
   defect to explain an infrastructure failure.`,
    placeholders: ['checkName', 'prUrl', 'worktreeLine']
  }
}

export function buildCiTriagePrompt(opts: {
  checkName: string
  prUrl: string
  worktreePath: string | null
  resolve?: (id: string) => string
}): string {
  const text = opts.resolve ? opts.resolve('review.ci.analyze') : CI_TRIAGE_PROMPTS.analyze.text
  return fillPrompt(text, {
    checkName: opts.checkName,
    prUrl: opts.prUrl,
    // The whole step, not a bare path: with no checkout there is no step 3 to do, and handing
    // the agent an empty path would send it reading whatever cwd it happens to have.
    worktreeLine: opts.worktreePath
      ? `Trace the error to the code. The pull request's head is checked out at ${opts.worktreePath} — read the failing file there, not in any other clone.`
      : `This pull request has no local checkout, so you cannot read its code directly. Work from the log alone and say what you could not verify.`
  })
}
