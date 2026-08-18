import { replayCase, type EvalRunners } from './replay'
import { replayCaseV3, type ReplayResultV3 } from './replayV3'
import { buildJudgePrompt, parseJudgeVerdict, type JudgeVerdict } from './judge'
import type { DistillEvalBundleLine, DistillEvalItem } from '../../../app/src/shared/distillEval'
import type { PipelineStages, PreStageDrop } from '../../../app/src/shared/distillV3'

/** Which distiller a replay drives: v2's single agentic call, or v3's staged pipeline. */
export type EvalPipeline = 'v2' | 'v3'

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
  /** `--pipeline v3` only: the per-stage records the staged pipeline produced (or the corpus
   *  line's own, on a reused case). Absent for every v2 replay. */
  stages?: PipelineStages
  /** `--pipeline v3` only: candidates the veto or a validator dropped before staging. */
  preStageDropped?: PreStageDrop[]
}

/**
 * Sequential on purpose — provider rate limits; a corpus is tens of cases, not thousands.
 * `runners.agent` replays the distill loop; `runners.oneShot` runs the judge (a single
 * prompt-in/verdict-out call, no tools) — and, under `pipeline: 'v3'`, the pipeline's tool-less
 * stages as well.
 *
 * `pipeline` picks WHICH distiller is replayed (v2's single agentic call or v3's staged
 * pipeline); everything downstream of the replay — parse classification, judging, the report —
 * is identical either way, which is the point: the two are comparable on the same corpus.
 */
export async function runEval(
  lines: DistillEvalBundleLine[],
  runners: EvalRunners,
  resolve?: (id: string) => string,
  pipeline: EvalPipeline = 'v2'
): Promise<EvalCaseResult[]> {
  const out: EvalCaseResult[] = []
  for (const line of lines) {
    // `ReplayResultV3` widens `ReplayResult` with two optional fields, so a v2 result is a
    // valid value of it — the rest of the loop is pipeline-blind.
    const r: ReplayResultV3 =
      pipeline === 'v3'
        ? await replayCaseV3(line, runners, resolve)
        : await replayCase(line, runners, resolve)
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
      itemVerdicts,
      ...(r.stages ? { stages: r.stages } : {}),
      ...(r.preStageDropped ? { preStageDropped: r.preStageDropped } : {})
    })
  }
  return out
}
