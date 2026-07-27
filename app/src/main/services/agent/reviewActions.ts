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
    title: 'Review action — apply the change and push',
    text: `Apply finding {findingId} ("{summary}") to {prUrl} and push it.

The finding says:

{body}

{suggestedChange}

Work in the PR worktree at {worktreePath} — that checkout IS the pull request's head; nothing
you do elsewhere reaches the PR. Steps, in order:

1. Read {anchor} and the code around it before changing anything. If the finding is wrong or
   already fixed, say so and stop — do not invent a change to justify the action.
2. Make the smallest edit that fixes it. Do not reformat, rename, or fix anything the finding
   did not raise.
3. Show the diff you produced (git diff in the worktree) and say in one line what it does.
4. Call push_review_change with finding_id {findingId}, pr set to the owner/repo#number that
   {prUrl} names (e.g. https://github.com/acme/widget/pull/42 is acme/widget#42) — this is
   checked against the pull request bound to this case and is how the approval card shows which
   one you mean — and a commit message in the repository's existing style. It commits what
   is on disk and pushes to the PR branch — it writes no code itself, so nothing you skipped in
   step 2 will be made up for here.

The push stops at a confirmation the user must accept. If they decline, leave the worktree as
it is and say so.`,
    placeholders: [
      'findingId',
      'summary',
      'prUrl',
      'body',
      'suggestedChange',
      'worktreePath',
      'anchor'
    ]
  }
}

/** Compose one action turn. Pure; `resolve` is the prompt-registry seam. */
export function buildReviewActionPrompt(opts: {
  action: ReviewAction
  findingId: number
  summary: string
  body: string
  suggestedChange: string | null
  /** `path:line`, repo-relative — what the comment will anchor to and what to read first. */
  anchor: string
  prUrl: string
  worktreePath: string | null
  resolve?: (id: string) => string
}): string {
  const text = opts.resolve
    ? opts.resolve(`review.action.${opts.action}`)
    : REVIEW_ACTION_PROMPTS[opts.action].text
  return fillPrompt(text, {
    findingId: String(opts.findingId),
    summary: opts.summary,
    body: opts.body,
    // A finding with no suggested change is still applicable — the agent derives the fix from
    // the body — but it must be told that, not handed an empty line that reads as a mistake.
    // The placeholder carries the WHOLE line (not just a value appended to a label) so the
    // no-suggestion case doesn't read back as "Suggested change: no suggested change...".
    suggestedChange: opts.suggestedChange
      ? `Suggested change: ${opts.suggestedChange}`
      : 'This finding records no suggested change — derive the fix from the finding body.',
    anchor: opts.anchor,
    prUrl: opts.prUrl,
    // In production, `action === 'apply'` reaching here always carries a non-null worktreePath:
    // composeReviewActionPrompt (reviewActionCompose.ts) throws review_write.no-worktree BEFORE
    // composing rather than calling this with `apply` and no worktree. This fallback is dead on
    // that path — it only fires if this pure function is called directly with `apply` and a null
    // worktreePath (as reviewActions.test.ts does), or for a `comment` turn, whose template
    // never references {worktreePath} at all. Kept (rather than tightening the type) so the
    // function stays testable/callable independent of the compose-layer guard.
    worktreePath: opts.worktreePath ?? '(no local checkout — re-enter review mode first)'
  })
}
