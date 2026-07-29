import { fillPrompt } from '../prompts/fill'
import type { PromptTextSpecs } from '../../../shared/promptSpec'

export type ReviewAction = 'comment' | 'apply'

export function isReviewAction(v: string): v is ReviewAction {
  return v === 'comment' || v === 'apply'
}

/**
 * The turn each finding-card write action sends. Composed in main (which owns the binding and
 * the worktree path) and delivered through the ordinary `agent.send`, so cancel, queue and
 * mirror behave exactly as they do for a typed message — the same shape Plan 3's review run
 * uses. Registered as `review.action.*` so both are editable like every other model-facing
 * string.
 */
export const REVIEW_ACTION_PROMPTS: PromptTextSpecs = {
  comment: {
    title: 'Review action — post as a PR comment',
    text: `Post finding {findingId} ("{summary}") as a comment on {prUrl}.

The finding says:

{body}

Call post_review_comment with finding_id {findingId}, pr set to the owner/repo#number that
{prUrl} names (e.g. https://github.com/acme/widget/pull/42 is acme/widget#42) — this is checked
against the pull request bound to this case and is how the approval card shows which one you
mean — and a body you write yourself: state the problem and the concrete failure
scenario in the reviewer's voice, addressed to the PR author. Keep it to a few sentences. Do not
restate the citation — the comment is anchored at {anchor} automatically. The user sees your body
and can edit it before it is posted, so write the text you would actually send.`,
    placeholders: ['findingId', 'summary', 'prUrl', 'body', 'anchor']
  },
  apply: {
    title: 'Review action — apply the selected findings and push',
    text: `Apply findings {findingIds} to {prUrl} and push them.

Read each one first with read_findings (finding_ids: [{findingIds}]) — do not work from memory.

Work in the PR worktree at \`{worktreePath}\` — that checkout IS the pull request's head; nothing
you do elsewhere reaches the PR. For each finding, in the order listed:

1. Read the cited code before changing anything. If the finding is wrong or already fixed, skip
   it — say why, and do not invent a change to justify the action.
2. Make the smallest edit that fixes it. Do not reformat, rename, or fix anything the finding
   did not raise.
3. Commit just that edit in the worktree, one commit per finding, message in the repository's
   existing style.

When all findings are handled, show the combined result (\`git log --oneline\` for your new
commits and \`git diff\` against where you started) with one line per finding on what it does.
Then call push_review_change once, with finding_ids listing only the ids you actually fixed,
pr set to the owner/repo#number that {prUrl} names, and a commit_message for any change you
left uncommitted (normally none).
{staleness}
The push stops at a confirmation the user must accept. The card offers approve or deny only —
to change WHICH findings are included, the user denies and re-selects, so name the skipped ids
clearly. If the user declines, leave the worktree as it is and say so.`,
    placeholders: ['findingIds', 'prUrl', 'worktreePath', 'staleness']
  }
}

/** Compose one action turn. Pure; `resolve` is the prompt-registry seam. */
export function buildReviewActionPrompt(opts: {
  action: 'comment'
  findingId: number
  summary: string
  body: string
  /** `path:line`, repo-relative — what the comment will anchor to. */
  anchor: string
  prUrl: string
  resolve?: (id: string) => string
}): string {
  const text = opts.resolve
    ? opts.resolve(`review.action.${opts.action}`)
    : REVIEW_ACTION_PROMPTS[opts.action].text
  return fillPrompt(text, {
    findingId: String(opts.findingId),
    summary: opts.summary,
    body: opts.body,
    anchor: opts.anchor,
    prUrl: opts.prUrl
  })
}

/** Compose the batch/single apply turn (Plan 6 §2/§3). Pure; ids are pre-sorted by caller. */
export function buildApplyActionPrompt(opts: {
  findingIds: number[]
  prUrl: string
  worktreePath: string
  /** Pre-rendered staleness paragraph, or '' — the placeholder carries the whole block. */
  staleness: string
  resolve?: (id: string) => string
}): string {
  const text = opts.resolve ? opts.resolve('review.action.apply') : REVIEW_ACTION_PROMPTS.apply.text
  return fillPrompt(text, {
    findingIds: opts.findingIds.join(', '),
    prUrl: opts.prUrl,
    worktreePath: opts.worktreePath,
    staleness: opts.staleness ? `\n${opts.staleness}\n` : ''
  })
}
