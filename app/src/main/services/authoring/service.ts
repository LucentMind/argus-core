import { buildDraftPrompt, buildImprovePrompt } from './prompts'
import type { AuthoringRequest } from '../../../shared/authoringIpc'

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
  run: (prompt: string) => Promise<string>,
  resolve?: (id: string) => string
): Promise<string> {
  return run(buildDraftPrompt(input, resolve))
}

export async function improveAsset(
  input: AuthoringRequest,
  run: (prompt: string) => Promise<string>,
  resolve?: (id: string) => string
): Promise<string> {
  return run(buildImprovePrompt(input, resolve))
}
