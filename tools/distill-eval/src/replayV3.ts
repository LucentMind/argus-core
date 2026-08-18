import { runCaseDistillPipeline } from '../../../app/src/main/services/distill/v3/pipeline'
import { caseDistillPipelineHash } from '../../../app/src/main/services/distill/v3/promptHash'
import { DistillAgentRunError } from '../../../app/src/main/services/distill/caseDistiller'
import { parseCaseDistillOutput } from '../../../app/src/main/services/distill/contract'
import type { DistillEvalBundleLine } from '../../../app/src/shared/distillEval'
import type { PipelineStages, PreStageDrop } from '../../../app/src/shared/distillV3'
import type { EvalRunners, ReplayResult } from './replay'

/**
 * A v3 replay result: the same shape `replayCase` returns, plus the per-stage record the staged
 * pipeline produces. `stages` is present on a reused line (copied from the corpus), on a clean
 * run, AND on a failed one (whatever stages completed before the failure) — it is the only way
 * to see WHERE a candidate lost an item, which is the whole point of `--pipeline v3`.
 */
export interface ReplayResultV3 extends ReplayResult {
  stages?: PipelineStages
  preStageDropped?: PreStageDrop[]
}

/**
 * Replay one corpus line through the v3 staged pipeline (dossier → summary ‖ candidates → veto
 * → materialize) instead of v2's single agentic call.
 *
 * Two adapters bridge the harness's runner bag to `PipelineRunners`:
 *
 * - `agent`: the pipeline hands us an `opts.mcpServer` it built from `input.world`, but the
 *   harness's `AgentRunner` takes a world and builds its OWN replay server over it
 *   (`createReplayMcpServer`, which additionally stubs the PTC tool the harness cannot host).
 *   Both are built from the SAME frozen world, so `opts.mcpServer` is deliberately IGNORED and
 *   the harness serves the world it already has — otherwise the runner would have to accept a
 *   pre-built server and the PTC stub would vanish. `opts.allowedTools`/`maxIterations` are
 *   ignored for the same reason: the harness runner already pins them to the app's constants
 *   (`DISTILL_ALLOWED_TOOLS` / `DISTILL_MAX_ITERATIONS`) — see agentRunner.ts.
 * - `oneShot`: stages 2a/2b/3 are plain prompt-in/text-out calls, which is exactly the harness's
 *   `OneShotRunner` (the same runner the judge uses). No usage is reported: the harness has no
 *   token/cost accounting, and a zero-filled `usage` would show up in the stage records as
 *   measured zeros rather than "not measured".
 */
export async function replayCaseV3(
  line: DistillEvalBundleLine,
  runners: EvalRunners,
  resolve?: (id: string) => string
): Promise<ReplayResultV3> {
  const reused = line.job.promptHash === caseDistillPipelineHash(resolve)
  const world = line.job.inputSnapshot.world ?? null
  const base = {
    jobId: line.job.id,
    caseSlug: line.job.caseSlug,
    reused,
    degradedReplay: !reused && world === null
  }

  if (reused) {
    // Same skip-if-unchanged deal as v2: the candidate prompts are byte-identical to the ones
    // that produced this line, so re-running would only spend model calls to reproduce it.
    const raw = line.job.rawOutput
    const stages = line.job.stages ? { stages: line.job.stages } : {}
    try {
      return { ...base, raw, parsed: parseCaseDistillOutput(raw), parseError: null, ...stages }
    } catch (e) {
      return { ...base, raw, parsed: null, parseError: (e as Error).message, ...stages }
    }
  }

  try {
    const run = await runCaseDistillPipeline(
      line.job.inputSnapshot,
      {
        agent: async (prompt) => {
          const r = await runners.agent(prompt, world)
          return {
            text: r.text,
            // The harness runner has no turn/tool/trajectory channel — it keeps only the last
            // assistant text (collectRun). Zeros here are "not measured"; nothing in the eval
            // path reads them (they exist for the app's job columns).
            turnCount: 0,
            toolCallCount: 0,
            trajectory: [],
            // Lossy on purpose: the harness runner reports ONLY the SDK's terminal subtype and
            // has no `capHit` channel, so every non-success subtype is mapped to the
            // `'iterations'` cap — including `error_during_execution`, which is really a crash.
            // The distinction survives where it matters: `capSubtype` rides through unchanged
            // and report.ts labels a non-`error_max_turns` subtype an agent error, not a
            // budget cap. What this mapping buys is the behaviour that matters here — the
            // pipeline refuses to parse a cut-off run's text instead of grading it.
            ...(r.capSubtype ? { capHit: 'iterations' as const, capSubtype: r.capSubtype } : {})
          }
        },
        oneShot: async (prompt) => ({ text: await runners.oneShot(prompt) })
      },
      resolve
    )
    return {
      ...base,
      raw: run.raw,
      parsed: run.output,
      parseError: null,
      ...(run.stages ? { stages: run.stages } : {}),
      ...(run.preStageDropped ? { preStageDropped: run.preStageDropped } : {})
    }
  } catch (e) {
    // Every pipeline-ending failure is a DistillAgentRunError carrying the stages it got
    // through; anything else (a broken runner, an unexpected throw) has no stages to report but
    // is still a failed case, never a crash of the whole eval run.
    const err = e instanceof DistillAgentRunError ? e : null
    return {
      ...base,
      raw: err?.raw ?? '',
      parsed: null,
      parseError: e instanceof Error ? e.message : String(e),
      ...(err?.capHit ? { capSubtype: err.capSubtype ?? err.capHit } : {}),
      ...(err?.agentMeta?.stages ? { stages: err.agentMeta.stages } : {})
    }
  }
}
