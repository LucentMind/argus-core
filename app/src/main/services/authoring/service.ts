import { buildDraftPrompt, buildImprovePrompt } from './prompts'
import type { AuthoringRequest } from '../../../shared/authoringIpc'
import type { HeadlessResult } from '../agent/driver'

/**
 * One tool-less headless prompt per call. Provider-blind by design: it receives a runner and
 * owns only the prompt, the same split `runCaseDistill` and `distillTarget` use. Resolving
 * WHICH provider runs it belongs to agent/headless.ts.
 *
 * The raw output is returned unchanged. It is NOT validated or repaired here — it lands in the
 * editor for the human to accept, and the save-time validators are the gate.
 */
export async function draftAsset(
  input: AuthoringRequest,
  // Widened for Task 10 (usage reporting); usage is dropped here for now, same as the other
  // headless consumers (refSync/distill.ts, caseDistiller.ts, rca/jobs.ts).
  run: (prompt: string) => Promise<HeadlessResult>,
  resolve?: (id: string) => string
): Promise<string> {
  const result = await run(buildDraftPrompt(input, resolve))
  return result.text
}

export async function improveAsset(
  input: AuthoringRequest,
  run: (prompt: string) => Promise<HeadlessResult>,
  resolve?: (id: string) => string
): Promise<string> {
  const result = await run(buildImprovePrompt(input, resolve))
  return result.text
}
