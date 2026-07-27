import { describe, it, expect } from 'vitest'
import { buildReviewActionPrompt, REVIEW_ACTION_PROMPTS } from '../reviewActions'

const base = {
  findingId: 7,
  summary: 'Inverted guard',
  body: 'The guard is inverted. See [widget/src/guard.ts:17].',
  suggestedChange: 'Flip the condition.',
  anchor: 'src/guard.ts:17',
  prUrl: 'https://github.com/acme/widget/pull/42',
  worktreePath: 'C:\\home\\worktrees\\widget-c1-pr42'
}

describe('buildReviewActionPrompt', () => {
  it('names the tool, the finding id and the anchor for a comment', () => {
    const p = buildReviewActionPrompt({ ...base, action: 'comment' })
    expect(p).toContain('post_review_comment')
    expect(p).toContain('finding_id 7')
    expect(p).toContain('src/guard.ts:17')
    expect(p).toContain('Inverted guard')
    expect(p).not.toContain('push_review_change')
  })

  it('tells the apply turn to edit first and push second', () => {
    const p = buildReviewActionPrompt({ ...base, action: 'apply' })
    expect(p).toContain(base.worktreePath)
    expect(p).toContain('Flip the condition.')
    expect(p).toContain('push_review_change')
    const editAt = p.indexOf('worktree')
    const pushAt = p.indexOf('push_review_change')
    expect(editAt).toBeLessThan(pushAt)
  })

  it('says so when the finding carries no suggested change', () => {
    const p = buildReviewActionPrompt({ ...base, action: 'apply', suggestedChange: null })
    expect(p).toMatch(/no suggested change/i)
  })

  it('routes every string through the resolver when one is supplied', () => {
    const p = buildReviewActionPrompt({
      ...base,
      action: 'comment',
      resolve: (id) => (id === 'review.action.comment' ? 'OVERRIDDEN {summary}' : 'x')
    })
    expect(p).toBe('OVERRIDDEN Inverted guard')
  })

  it('declares every placeholder it fills', () => {
    for (const [key, spec] of Object.entries(REVIEW_ACTION_PROMPTS)) {
      for (const m of spec.text.matchAll(/\{(\w+)\}/g)) {
        expect(spec.placeholders ?? [], `${key} declares ${m[1]}`).toContain(m[1])
      }
    }
  })
})
