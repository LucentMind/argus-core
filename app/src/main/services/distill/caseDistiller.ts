import type { CreateQueryFn } from '../agent/drivers/claude'
import type { CaseDistillInput, CaseDistillOutput } from '../../../shared/distill'
import { runOneShot, type DistillOptions } from '../refSync/distill'
import { buildCaseDistillPrompt, parseCaseDistillOutput } from './contract'

export interface CaseDistillRun {
  raw: string
  output: CaseDistillOutput
}

/** v1 distiller: tool-less one-shot (spec "A now, B later"). Swap internals here for a
 *  tool-enabled headless session later — callers only see CaseDistillRun. */
export async function runCaseDistill(
  input: CaseDistillInput,
  opts: DistillOptions = {},
  createQuery?: CreateQueryFn
): Promise<CaseDistillRun> {
  const raw = await runOneShot(buildCaseDistillPrompt(input), opts, createQuery)
  return { raw, output: parseCaseDistillOutput(raw) }
}
