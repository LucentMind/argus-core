import type { CaseDistillInput, CaseDistillOutput } from '../../../shared/distill'
import { buildCaseDistillPrompt, parseCaseDistillOutput } from './contract'

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
  run: (prompt: string, opts?: { signal?: AbortSignal }) => Promise<string>,
  resolve?: (id: string) => string,
  signal?: AbortSignal
): Promise<CaseDistillRun> {
  const raw = await run(buildCaseDistillPrompt(input, resolve), signal ? { signal } : undefined)
  return { raw, output: parseCaseDistillOutput(raw) }
}
