import { describe, it, expect } from 'vitest'
import {
  buildReviewActionPrompt,
  buildApplyActionPrompt,
  REVIEW_ACTION_PROMPTS
} from '../reviewActions'

const base = {
  findingId: 7,
  summary: 'Inverted guard',
  body: 'The guard is inverted. See [widget/src/guard.ts:17].',
  anchor: 'src/guard.ts:17',
  prUrl: 'https://github.com/acme/widget/pull/42'
}

describe('buildReviewActionPrompt (comment)', () => {
  it('names the tool, the finding id and the anchor for a comment', () => {
    const p = buildReviewActionPrompt({ ...base, action: 'comment' })
    expect(p).toContain('post_review_comment')
    expect(p).toContain('finding_id 7')
    expect(p).toContain('src/guard.ts:17')
    expect(p).toContain('Inverted guard')
    expect(p).not.toContain('push_review_change')
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

describe('buildApplyActionPrompt', () => {
  const applyBase = {
    findingIds: [3, 7],
    prUrl: 'https://github.com/acme/widget/pull/42',
    worktreePath: 'C:\\home\\worktrees\\widget-c1-pr42',
    staleness: ''
  }

  it('names every id, the worktree path, and read_findings, and pushes second', () => {
    const p = buildApplyActionPrompt(applyBase)
    expect(p).toContain('Apply findings 3, 7')
    expect(p).toContain(applyBase.worktreePath)
    expect(p).toContain('read_findings')
    expect(p).toContain('push_review_change')
    const readAt = p.indexOf('read_findings')
    const pushAt = p.indexOf('push_review_change')
    expect(readAt).toBeLessThan(pushAt)
  })

  it('inlines a supplied staleness paragraph', () => {
    const p = buildApplyActionPrompt({
      ...applyBase,
      staleness: 'Finding 7 was recorded at oldhead00000; the PR head is now currenthead0.'
    })
    expect(p).toContain('Finding 7 was recorded at oldhead00000; the PR head is now currenthead0.')
  })

  it('leaves no stray placeholder text when there is no staleness note', () => {
    const p = buildApplyActionPrompt(applyBase)
    expect(p).not.toContain('{staleness}')
  })

  it('routes through the resolver when one is supplied', () => {
    const p = buildApplyActionPrompt({
      ...applyBase,
      resolve: (id) => (id === 'review.action.apply' ? 'OVERRIDDEN {findingIds}' : 'x')
    })
    expect(p).toBe('OVERRIDDEN 3, 7')
  })
})
