import {
  buildCaseDistillPrompt,
  parseCaseDistillOutput,
  CASE_DISTILL_SECTIONS
} from '../../../app/src/main/services/distill/contract'
import { caseDistillPromptHash } from '../../../app/src/main/services/distill/promptHash'
import type { CaseDistillOutput } from '../../../app/src/shared/distill'
import type { DistillEvalBundleLine } from '../../../app/src/shared/distillEval'
import type { OneShotRunner } from './runner'

export interface ReplayResult {
  jobId: number
  caseSlug: string
  /** candidate static-part hash equals the job's stored promptHash — stored raw reused, no model call */
  reused: boolean
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
  run: OneShotRunner,
  resolve?: (id: string) => string
): Promise<ReplayResult> {
  const base = { jobId: line.job.id, caseSlug: line.job.caseSlug }
  const reused = line.job.promptHash === caseDistillPromptHash(resolve)
  const raw = reused
    ? line.job.rawOutput
    : await run(buildCaseDistillPrompt(line.job.inputSnapshot, resolve))
  try {
    return { ...base, reused, raw, parsed: parseCaseDistillOutput(raw), parseError: null }
  } catch (e) {
    return { ...base, reused, raw, parsed: null, parseError: (e as Error).message }
  }
}
