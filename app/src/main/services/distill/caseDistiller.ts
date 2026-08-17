import type { CaseDistillInput, CaseDistillOutput } from '../../../shared/distill'
import { buildCaseDistillPrompt, parseCaseDistillOutput } from './contract'
import type { HeadlessResult } from '../agent/driver'

export interface CaseDistillRun {
  raw: string
  output: CaseDistillOutput
}

/**
 * v1 distiller: one tool-less headless prompt. Deliberately provider-blind — it receives a
 * runner and owns only the prompt and the parse. Resolving WHICH provider runs it belongs to
 * agent/headless.ts; conflating the two is what let the active chat instance's "auto" model
 * reach the Claude SDK.
 */
export async function runCaseDistill(
  input: CaseDistillInput,
  // Widened for Task 10 (usage reporting); usage is dropped here for now (temporarily,
  // per plan) — `raw` stays the text so the parse/stage pipeline below is unaffected.
  run: (prompt: string, opts?: { signal?: AbortSignal }) => Promise<HeadlessResult>,
  resolve?: (id: string) => string,
  signal?: AbortSignal
): Promise<CaseDistillRun> {
  const result = await run(buildCaseDistillPrompt(input, resolve), signal ? { signal } : undefined)
  const raw = result.text
  return { raw, output: parseCaseDistillOutput(raw) }
}
