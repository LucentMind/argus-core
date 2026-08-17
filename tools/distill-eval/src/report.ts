import fs from 'node:fs'
import path from 'node:path'
import type { EvalCaseResult } from './run'

export function writeReport(
  outDir: string,
  results: EvalCaseResult[]
): { reportPath: string; detailsPath: string } {
  fs.mkdirSync(outDir, { recursive: true })
  const verdicts = results.flatMap((r) => r.itemVerdicts.map((v) => ({ ...v, caseSlug: r.caseSlug, jobId: r.jobId })))
  const count = (k: string): number => verdicts.filter((v) => v.verdict.verdict === k).length
  const parse = (k: EvalCaseResult['parseOutcome']): number => results.filter((r) => r.parseOutcome === k).length
  const byTag = new Map<string, { improved: number; total: number }>()
  for (const v of verdicts) {
    if (v.item.outcome !== 'rejected') continue
    const tag = v.item.rejectReason ?? 'untagged'
    const e = byTag.get(tag) ?? { improved: 0, total: 0 }
    e.total++
    if (v.verdict.verdict === 'improved') e.improved++
    byTag.set(tag, e)
  }
  const needsHuman = verdicts.filter((v) => v.verdict.verdict === 'needs-human')
  const degraded = results.filter((r) => r.degradedReplay)
  const capped = results.filter((r) => r.capSubtype)
  // `error_max_turns` is the one subtype that is actually a budget cap (the app's own
  // DISTILL_MAX_ITERATIONS bound); every other terminal subtype (`error_during_execution`,
  // `error_max_budget_usd` reached mid-turn, …) is a genuine agent error, not exhaustion — calling
  // all of them "budget-exhausted" would misdescribe a crash as a limit working as intended.
  const capLabel = (subtype: string): string =>
    subtype === 'error_max_turns' ? 'budget-exhausted' : `agent-error (${subtype})`
  const md = [
    '# Distill-eval report',
    '',
    `Cases: ${results.length} (${results.filter((r) => r.reused).length} reused baseline output — prompt unchanged for them)`,
    // A degraded replay compared a candidate that could not read transcripts against a baseline
    // that could; it is not a like-for-like verdict. Named, never averaged in silently.
    `Degraded replays (pre-v2 line, no world — tools answered "unavailable"): ${degraded.length}${degraded.length ? ` — ${degraded.map((r) => `${r.caseSlug} #${r.jobId}`).join(', ')}` : ''}`,
    // A capped/errored run's output is not a candidate sample — the app fails such jobs rather
    // than parsing them, so these are neither graded nor counted ok. Named so a big "ungraded"
    // gap in the numbers has a visible cause (usually: the candidate contract loops, or a real
    // agent error — see each case's label for which).
    `Capped or errored replays (agent did not finish, NOT graded): ${capped.length}${capped.length ? ` — ${capped.map((r) => `${r.caseSlug} #${r.jobId} (${capLabel(r.capSubtype!)})`).join(', ')}` : ''}`,
    `Parse: ok ${parse('ok')} · improved ${parse('parse-improved')} · REGRESSED ${parse('parse-regressed')} · still-failing ${parse('still-failing')}`,
    `Item verdicts: improved ${count('improved')} · unchanged ${count('unchanged')} · regressed ${count('regressed')} · needs-human ${count('needs-human')}`,
    '',
    '## Needs human review (read these first)',
    ...needsHuman.map((v) => `- [${v.caseSlug} #${v.jobId}] ${v.item.title}: ${v.verdict.reason}`),
    '',
    '## By reject tag (improved / total)',
    ...[...byTag.entries()].map(([tag, e]) => `- ${tag}: ${e.improved}/${e.total}`),
    ''
  ].join('\n')
  const reportPath = path.join(outDir, 'report.md')
  const detailsPath = path.join(outDir, 'details.jsonl')
  fs.writeFileSync(reportPath, md)
  fs.writeFileSync(detailsPath, results.map((r) => JSON.stringify(r)).join('\n') + (results.length ? '\n' : ''))
  return { reportPath, detailsPath }
}
