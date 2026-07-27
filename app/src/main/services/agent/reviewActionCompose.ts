import type { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { assertSlug } from '../caseFiles'
import { caseDir } from '../paths'
import { parseFindingBodies } from '../findings'
import { resolveReviewFraming, type ReviewFramingDeps } from './reviewFraming'
import { findingForCase, resolveCommentTarget, type ReviewWriteDeps } from './reviewWrites'
import { buildReviewActionPrompt, isReviewAction } from './reviewActions'

export interface ComposeReviewActionDeps extends ReviewFramingDeps, ReviewWriteDeps {
  db: DatabaseSync
  argusHome: string
  resolvePrompt?: (id: string) => string
}

/**
 * The body of the `review:compose-action-prompt` IPC handler, out of main/index.ts so it is
 * testable without booting Electron — the same posture as reviewRunCompose.ts.
 *
 * Ownership is checked BEFORE anything else, through the same seams the write tools use:
 * `resolveReviewFraming` (the session belongs to the case) and `findingForCase` (the finding
 * belongs to the case). A composed prompt is not itself a write, but it names a finding id the
 * agent will hand straight to a write tool, so it must not be composable across cases.
 */
export async function composeReviewActionPrompt(
  deps: ComposeReviewActionDeps,
  caseSlug: string,
  sessionId: number,
  findingId: number,
  action: string
): Promise<string> {
  assertSlug(caseSlug)
  if (!Number.isInteger(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
  if (!Number.isInteger(findingId)) throw new Error(`Invalid finding id: ${findingId}`)
  if (!isReviewAction(action)) throw new Error(`Unknown review action: ${JSON.stringify(action)}`)

  resolveReviewFraming(deps, caseSlug, sessionId)
  const row = findingForCase(deps, caseSlug, findingId)
  const target = resolveCommentTarget(deps, caseSlug, findingId)

  let body = ''
  try {
    const md = fs.readFileSync(path.join(caseDir(deps.argusHome, caseSlug), 'findings.md'), 'utf8')
    body = parseFindingBodies(md).get(findingId) ?? ''
  } catch {
    // no findings.md (or unreadable) — the summary alone still composes a usable turn
  }

  return buildReviewActionPrompt({
    action,
    findingId,
    summary: row.summary,
    body,
    suggestedChange: row.suggested_change,
    anchor: `${target.repoRelPath}:${target.line}`,
    prUrl: target.binding.url,
    worktreePath: target.worktree,
    resolve: deps.resolvePrompt
  })
}
