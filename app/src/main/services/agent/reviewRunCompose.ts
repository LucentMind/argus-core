import type { DatabaseSync } from 'node:sqlite'
import { isReviewLayerId } from '../../../shared/reviewLayers'
import type { PrBinding } from '../../../shared/pr'
import { assertSlug } from '../caseFiles'
import type { PrMaterializer } from '../prBindings'
import { buildReviewRunPrompt } from './reviewRun'
import { resolveReviewFraming, type ReviewFramingDeps } from './reviewFraming'

export interface ComposeReviewRunPromptDeps extends ReviewFramingDeps {
  db: DatabaseSync
  getBinding: (db: DatabaseSync, caseSlug: string) => PrBinding | null
  materialize: PrMaterializer
  resolvePrompt?: (id: string) => string
}

/**
 * The body of the `review:compose-run-prompt` IPC handler, pulled out of main/index.ts so it
 * is testable without booting Electron — the main-process DI convention every other handler
 * in this file follows (see session.subagents.test.ts and friends: construct real deps against
 * an in-memory/temp-file DB, never `vi.mock('electron')`). `ipcMain.handle` in index.ts is now
 * a thin wrapper that supplies the live deps and calls this.
 *
 * Ownership and framing are resolved through `resolveReviewFraming` (reviewFraming.ts) BEFORE
 * any side-effecting work (worktree materialization) — same posture as
 * AgentService.getOrCreate: a doomed request (unknown case, a sessionId from another case) must
 * fail before it touches the filesystem, and the driver this session is REALLY running on
 * (not a static capability table keyed on a possibly-null instance_id) decides whether the
 * composed turn can delegate by name or must inline the layer bodies (findings 2/3 of the
 * layered-review review).
 */
export async function composeReviewRunPrompt(
  deps: ComposeReviewRunPromptDeps,
  caseSlug: string,
  sessionId: number,
  layerIds: string[]
): Promise<string> {
  assertSlug(caseSlug)
  if (!Number.isInteger(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
  const layers = layerIds.filter(isReviewLayerId)
  if (layers.length !== layerIds.length) {
    throw new Error(`Unknown review layer in ${JSON.stringify(layerIds)}`)
  }

  const framing = resolveReviewFraming(deps, caseSlug, sessionId)

  const binding = deps.getBinding(deps.db, caseSlug)
  if (!binding) throw new Error('No pull request is bound to this case.')
  const worktree = await deps.materialize(binding)
  if (!worktree) {
    throw new Error(`PR #${binding.number} has no linked local repo to check out.`)
  }

  return buildReviewRunPrompt({
    support: framing.support,
    pinnedLayers: layers,
    prUrl: binding.url,
    worktreePath: worktree,
    repoName: binding.repo,
    resolve: deps.resolvePrompt
  })
}
