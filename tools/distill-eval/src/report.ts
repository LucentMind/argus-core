import fs from 'node:fs'
import path from 'node:path'
import type { EvalCaseResult } from './run'
import type { DistillEvalItem } from '../../../app/src/shared/distillEval'
import type { PipelineStages, PreStageDrop } from '../../../app/src/shared/distillV3'

/** Where a gold item died in the v3 pipeline. `materialized` means the pipeline DID produce
 *  something for that target — so a bad verdict on it is a content problem, not a routing or
 *  veto drop. */
export type Attribution = 'not-in-dossier' | 'not-a-candidate' | `vetoed:${string}` | 'materialized'

/** Words worth searching for out of a gold item's target + title. Two chars and under are
 *  noise ("a", "of", "x") that would match almost any stage output. */
function itemTokens(item: DistillEvalItem): string[] {
  return `${item.target} ${item.title}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2)
}

const mentions = (raw: string | undefined, tokens: string[]): boolean => {
  if (raw === undefined) return false
  // Lowercased once, not once per token — a dossier raw output is tens of KB.
  const hay = raw.toLowerCase()
  return tokens.some((t) => hay.includes(t))
}

/**
 * Attribute one gold item to the stage that lost it. Deliberately crude: plain token
 * containment over each stage's raw output, walked in pipeline order, first miss wins. It
 * cannot know that the dossier described the same fact in different words, so read it as a
 * pointer at which stage to open in `details.jsonl`, never as a measurement. An item with no
 * usable tokens (a one-or-two-char target and title) can never match and reports
 * `not-in-dossier`.
 */
export function attributeItem(
  item: DistillEvalItem,
  stages: PipelineStages,
  dropped: PreStageDrop[] = []
): Attribution {
  const tokens = itemTokens(item)
  if (!mentions(stages.dossier?.rawOutput, tokens)) return 'not-in-dossier'
  if (!mentions(stages.candidates?.rawOutput, tokens)) return 'not-a-candidate'
  // Drops are matched on target + type, the two identifiers a gold item shares with a candidate
  // (titles are model-written and drift between runs, so they are not part of the match). Type
  // matters as well as target: one run can legitimately materialize `skill-edit diagnose-x`
  // while vetoing `skill-new diagnose-x` as a duplicate of it, and matching on target alone
  // would then report a materialized item as vetoed.
  const drop = dropped.find((d) => d.target === item.target && d.type === item.type)
  if (drop) return `vetoed:${drop.reason}`
  return 'materialized'
}

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
  // v3 only: one line per graded gold item saying which stage lost it. Cases whose replay was
  // never graded (parse failure, cap) have no item verdicts and so contribute nothing here —
  // the summary lines above already name them, and their `stages` are in details.jsonl.
  const attributions = results
    .filter((r) => r.stages)
    .flatMap((r) =>
      r.itemVerdicts.map(
        (v) =>
          `- [${r.caseSlug} #${r.jobId}] ${v.item.title} (${v.item.type} → ${v.item.target}): ${attributeItem(v.item, r.stages!, r.preStageDropped)}`
      )
    )
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
    '',
    // Only emitted for a `--pipeline v3` run; a v2 report keeps its old shape byte for byte.
    ...(attributions.length
      ? [
          '## v3 stage attribution (token containment — a pointer, not a measurement)',
          ...attributions,
          ''
        ]
      : [])
  ].join('\n')
  const reportPath = path.join(outDir, 'report.md')
  const detailsPath = path.join(outDir, 'details.jsonl')
  fs.writeFileSync(reportPath, md)
  fs.writeFileSync(detailsPath, results.map((r) => JSON.stringify(r)).join('\n') + (results.length ? '\n' : ''))
  return { reportPath, detailsPath }
}
