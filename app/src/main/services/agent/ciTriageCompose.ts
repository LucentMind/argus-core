import type { DatabaseSync } from 'node:sqlite'
import { assertSlug } from '../caseFiles'
import { getBinding } from '../prBindings'
import { assertSessionForCase } from './reviewFraming'
import { worktreeFor, wf, type ReviewWriteDeps } from './reviewWrites'
import { buildCiTriagePrompt } from './ciTriage'

export interface ComposeCiTriageDeps extends ReviewWriteDeps {
  db: DatabaseSync
  argusHome: string
  resolvePrompt?: (id: string) => string
}

/**
 * The body of the `review:compose-ci-prompt` IPC handler, out of main/index.ts so it is testable
 * without booting Electron — the same posture as reviewRunCompose.ts and reviewActionCompose.ts.
 *
 * Ownership is checked through the same seam the write paths use (`assertSessionForCase`: the
 * session belongs to the case). Composing is not itself a write, but the turn it produces names
 * a case whose bound PR the agent will read, so it must not be composable across cases.
 *
 * Unlike the other two composers this does NOT call `resolveReviewFraming`: the framing it would
 * return (whether to inline layer bodies or register subagents) has no bearing on a single-pass
 * triage turn, and asking for it would drag a driver resolution — and therefore live settings —
 * into a function whose whole job is to interpolate three strings.
 */
export async function composeCiTriagePrompt(
  deps: ComposeCiTriageDeps,
  caseSlug: string,
  sessionId: number,
  checkName: string
): Promise<string> {
  assertSlug(caseSlug)
  if (!Number.isInteger(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
  if (typeof checkName !== 'string' || !checkName.trim()) {
    throw new Error(`Invalid check name: ${JSON.stringify(checkName)}`)
  }

  assertSessionForCase(deps.db, caseSlug, sessionId)
  const binding = getBinding(deps.db, caseSlug)
  if (!binding) throw new Error(wf(deps, 'review_write.no-binding'))

  return buildCiTriagePrompt({
    checkName: checkName.trim(),
    prUrl: binding.url,
    worktreePath: worktreeFor(deps, caseSlug, binding),
    resolve: deps.resolvePrompt
  })
}
