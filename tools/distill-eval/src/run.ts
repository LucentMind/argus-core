import { replayCase, type EvalRunners } from './replay'
import { buildJudgePrompt, parseJudgeVerdict, type JudgeVerdict } from './judge'
import type { DistillEvalBundleLine, DistillEvalItem } from '../../../app/src/shared/distillEval'

export interface EvalCaseResult {
  jobId: number
  caseSlug: string
  reused: boolean
  /** replayed with no world to serve — see `ReplayResult.degradedReplay` */
  degradedReplay: boolean
  /** the agent run was cut off by a budget — see `ReplayResult.capSubtype` */
  capSubtype?: string
  /**
   * `budget-exhausted` outranks every parse verdict: a capped run's text is not a fair sample of
   * the candidate contract (the app fails such jobs instead of parsing them), so it is neither
   * counted `ok` nor graded — the items are skipped and the report names the case.
   */
  parseOutcome: 'ok' | 'parse-regressed' | 'parse-improved' | 'still-failing' | 'budget-exhausted'
  itemVerdicts: { item: DistillEvalItem; verdict: JudgeVerdict }[]
}

/**
 * Sequential on purpose — provider rate limits; a corpus is tens of cases, not thousands.
 * `runners.agent` replays the distill loop; `runners.oneShot` runs the judge (a single
 * prompt-in/verdict-out call, no tools).
 */
export async function runEval(
  lines: DistillEvalBundleLine[],
  runners: EvalRunners,
  resolve?: (id: string) => string
): Promise<EvalCaseResult[]> {
  const out: EvalCaseResult[] = []
  for (const line of lines) {
    const r = await replayCase(line, runners, resolve)
    const wasFailed = line.job.state === 'failed'
    const parseOutcome: EvalCaseResult['parseOutcome'] = r.capSubtype
      ? 'budget-exhausted'
      : r.parseError
        ? wasFailed
          ? 'still-failing'
          : 'parse-regressed'
        : wasFailed
          ? 'parse-improved'
          : 'ok'
    const itemVerdicts: EvalCaseResult['itemVerdicts'] = []
    if (parseOutcome === 'ok') {
      for (const item of line.items) {
        let verdict: JudgeVerdict
        if (r.reused) {
          verdict = { verdict: 'unchanged', reason: 'prompt unchanged — baseline output reused' }
        } else {
          try {
            verdict = parseJudgeVerdict(
              await runners.oneShot(buildJudgePrompt(item, line.job.rawOutput, r.raw))
            )
          } catch (e) {
            verdict = { verdict: 'needs-human', reason: `judge output unusable: ${(e as Error).message}` }
          }
        }
        itemVerdicts.push({ item, verdict })
      }
    }
    out.push({
      jobId: r.jobId,
      caseSlug: r.caseSlug,
      reused: r.reused,
      degradedReplay: r.degradedReplay,
      ...(r.capSubtype ? { capSubtype: r.capSubtype } : {}),
      parseOutcome,
      itemVerdicts
    })
  }
  return out
}
