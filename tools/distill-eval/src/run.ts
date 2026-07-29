import { replayCase } from './replay'
import { buildJudgePrompt, parseJudgeVerdict, type JudgeVerdict } from './judge'
import type { OneShotRunner } from './runner'
import type { DistillEvalBundleLine, DistillEvalItem } from '../../../app/src/shared/distillEval'

export interface EvalCaseResult {
  jobId: number
  caseSlug: string
  reused: boolean
  parseOutcome: 'ok' | 'parse-regressed' | 'parse-improved' | 'still-failing'
  itemVerdicts: { item: DistillEvalItem; verdict: JudgeVerdict }[]
}

/** Sequential on purpose — provider rate limits; a corpus is tens of cases, not thousands. */
export async function runEval(
  lines: DistillEvalBundleLine[],
  run: OneShotRunner,
  judgeRun: OneShotRunner,
  resolve?: (id: string) => string
): Promise<EvalCaseResult[]> {
  const out: EvalCaseResult[] = []
  for (const line of lines) {
    const r = await replayCase(line, run, resolve)
    const wasFailed = line.job.state === 'failed'
    const parseOutcome = r.parseError
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
        try {
          verdict = parseJudgeVerdict(await judgeRun(buildJudgePrompt(item, line.job.rawOutput, r.raw)))
        } catch (e) {
          verdict = { verdict: 'needs-human', reason: `judge output unusable: ${(e as Error).message}` }
        }
        itemVerdicts.push({ item, verdict })
      }
    }
    out.push({ jobId: r.jobId, caseSlug: r.caseSlug, reused: r.reused, parseOutcome, itemVerdicts })
  }
  return out
}
