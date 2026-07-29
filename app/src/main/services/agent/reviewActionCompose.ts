import type { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { assertSlug } from '../caseFiles'
import { caseDir } from '../paths'
import { parseFindingBodies } from '../findings'
import { resolveReviewFraming, type ReviewFramingDeps } from './reviewFraming'
import { findingForCase, resolveCommentTarget, wf, type ReviewWriteDeps } from './reviewWrites'
import { buildReviewActionPrompt, buildApplyActionPrompt, isReviewAction } from './reviewActions'
import { prHead, defaultGhRunner } from '../github'

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
  findingIds: number[],
  action: string
): Promise<string> {
  assertSlug(caseSlug)
  if (!Number.isInteger(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
  if (findingIds.length === 0 || findingIds.some((n) => !Number.isInteger(n))) {
    throw new Error(`Invalid finding ids: ${JSON.stringify(findingIds)}`)
  }
  if (!isReviewAction(action)) throw new Error(`Unknown review action: ${JSON.stringify(action)}`)
  if (action === 'comment' && findingIds.length !== 1) {
    throw new Error('The comment action takes exactly one finding.')
  }

  resolveReviewFraming(deps, caseSlug, sessionId)
  // Ownership + anchor per id, exactly the checks the write tools will re-run.
  const targets = findingIds.map((id) => ({
    id,
    row: findingForCase(deps, caseSlug, id),
    target: resolveCommentTarget(deps, caseSlug, id)
  }))
  const first = targets[0].target

  if (action === 'comment') {
    // Unchanged single-finding fallback turn (Plan 4 shape) — used only when the finding
    // predates comment_body.
    let body = ''
    try {
      const md = fs.readFileSync(
        path.join(caseDir(deps.argusHome, caseSlug), 'findings.md'),
        'utf8'
      )
      body = parseFindingBodies(md).get(findingIds[0]) ?? ''
    } catch {
      // no findings.md — the summary alone still composes a usable turn
    }
    return buildReviewActionPrompt({
      action: 'comment',
      findingId: findingIds[0],
      summary: targets[0].row.summary,
      body,
      anchor: `${first.repoRelPath}:${first.line}`,
      prUrl: first.binding.url,
      resolve: deps.resolvePrompt
    })
  }

  // `worktreeFor` legitimately returns null (a manual link to an unlinked repo, a failed
  // materialization, or a PR linked after the last review-mode entry). The comment action needs
  // no checkout, but apply's whole prompt is "edit the worktree at {worktreePath}" — composing
  // that with no worktree would send the agent editing the user's real linked clone (which IS
  // inside the sandbox and auto-allowed) instead, only to have push_review_change throw
  // `no-worktree` afterward and leave the stray edits behind unmentioned. Fail before composing.
  if (!first.worktree) {
    throw new Error(wf(deps, 'review_write.no-worktree', { number: String(first.binding.number) }))
  }
  // Apply in file-and-line order, not selection order — two fixes in one file must not fight
  // over line numbers (spec §3).
  targets.sort(
    (a, b) =>
      (a.target.repoRelPath < b.target.repoRelPath
        ? -1
        : a.target.repoRelPath > b.target.repoRelPath
          ? 1
          : 0) || a.target.line - b.target.line
  )
  // Staleness: findings recorded against an older PR head get a re-verify warning in the turn.
  // Best-effort — an offline compose still composes (the write path will fail loudly later).
  let staleness = ''
  try {
    const b = first.binding
    const head = await prHead(deps.gh ?? defaultGhRunner, `${b.owner}/${b.repo}`, b.number)
    const stale = targets.filter((t) => t.row.head_sha && t.row.head_sha !== head.sha)
    if (stale.length > 0) {
      staleness = stale
        .map(
          (t) =>
            `Finding ${t.id} was recorded at ${t.row.head_sha!.slice(0, 12)}; the PR head is now ${head.sha.slice(0, 12)}. Re-verify it against the current code before applying.`
        )
        .join('\n')
    }
  } catch {
    // no network / no gh — omit the note rather than failing the compose
  }
  return buildApplyActionPrompt({
    findingIds: targets.map((t) => t.id),
    prUrl: first.binding.url,
    worktreePath: first.worktree,
    staleness,
    resolve: deps.resolvePrompt
  })
}
