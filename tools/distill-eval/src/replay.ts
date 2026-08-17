import {
  buildCaseDistillPrompt,
  parseCaseDistillOutput,
  CASE_DISTILL_SECTIONS
} from '../../../app/src/main/services/distill/contract'
import { caseDistillPromptHash } from '../../../app/src/main/services/distill/promptHash'
import type { CaseDistillOutput } from '../../../app/src/shared/distill'
import type { DistillEvalBundleLine } from '../../../app/src/shared/distillEval'
import type { OneShotRunner } from './runner'
import type { AgentReplayResult, AgentRunner } from './agentRunner'

/**
 * The harness's runner set, passed around whole so replay and judge share one pair. `agent` runs
 * the candidate distill loop over the frozen world; `oneShot` is the plain prompt-in/text-out
 * runner the judge uses (`runEval`). Replay itself only calls `agent` — a v2 distill run is
 * agentic by definition.
 */
export interface EvalRunners {
  oneShot: OneShotRunner
  agent: AgentRunner
}

export interface ReplayResult {
  jobId: number
  caseSlug: string
  /** candidate static-part hash equals the job's stored promptHash — stored raw reused, no model call */
  reused: boolean
  /**
   * The replay ran agentically but with NO world to serve (a pre-v2 corpus line): every tool call
   * answered the distinguished "unavailable" error, so the candidate saw a strictly poorer
   * environment than the live run did. Reported rather than silently compared. Always false for a
   * reused line, where no replay happened at all.
   */
  degradedReplay: boolean
  /**
   * The agent run was cut off by a budget rather than ending cleanly — the SDK's terminal
   * non-success `result.subtype`. Its text is NOT a fair sample of the candidate contract: the app
   * fails a capped distill job instead of parsing it, so `runEval` refuses to grade these too
   * (`parseOutcome: 'budget-exhausted'`) and the report names them. Undefined on a clean or reused
   * replay.
   */
  capSubtype?: string
  raw: string
  parsed: CaseDistillOutput | null
  parseError: string | null
}

/** --contract file → resolver overriding ONLY the contract id; null → undefined (repo defaults). */
export function contractResolver(contractText: string | null): ((id: string) => string) | undefined {
  if (contractText === null) return undefined
  return (id) => {
    if (id === 'headless.case-distill.contract') return contractText
    const key = id.replace('headless.case-distill.section.', '')
    if (key in CASE_DISTILL_SECTIONS) return CASE_DISTILL_SECTIONS[key].text
    throw new Error(`unknown prompt id: ${id}`)
  }
}

export async function replayCase(
  line: DistillEvalBundleLine,
  runners: EvalRunners,
  resolve?: (id: string) => string
): Promise<ReplayResult> {
  const reused = line.job.promptHash === caseDistillPromptHash(resolve)
  const world = line.job.inputSnapshot.world ?? null
  const outcome: AgentReplayResult = reused
    ? { text: line.job.rawOutput }
    : await runners.agent(buildCaseDistillPrompt(line.job.inputSnapshot, resolve), world)
  const raw = outcome.text
  const base = {
    jobId: line.job.id,
    caseSlug: line.job.caseSlug,
    reused,
    degradedReplay: !reused && world === null,
    ...(outcome.capSubtype ? { capSubtype: outcome.capSubtype } : {})
  }
  try {
    return { ...base, raw, parsed: parseCaseDistillOutput(raw), parseError: null }
  } catch (e) {
    return { ...base, raw, parsed: null, parseError: (e as Error).message }
  }
}
