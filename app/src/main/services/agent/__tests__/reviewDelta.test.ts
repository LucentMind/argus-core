// app/src/main/services/agent/__tests__/reviewDelta.test.ts
import { describe, it, expect } from 'vitest'
import {
  ReviewDeltaQueue,
  renderReviewDeltaLine,
  renderReviewEditLine,
  REVIEW_DELTA_PROMPTS
} from '../reviewDelta'
import type { FindingRow } from '../../../../shared/observability'

function row(over: Partial<FindingRow>): FindingRow {
  return {
    id: 4,
    caseId: 1,
    sessionId: 1,
    turnId: null,
    summary: 'Race in parser',
    reviewState: 'pending',
    reviewedAt: null,
    createdAt: 'x',
    layer: null,
    severity: null,
    diffPath: null,
    diffLine: null,
    suggestedChange: null,
    commentUrl: null,
    pushedSha: null,
    commentBody: null,
    headSha: null,
    reviewReason: null,
    reviewActor: null,
    rejectTag: null,
    rejectNote: null,
    mode: 'investigation',
    role: null,
    status: 'confirmed',
    roleSource: null,
    causedBy: null,
    supersededBy: null,
    ...over
  }
}

describe('renderReviewDeltaLine', () => {
  it('renders accept, tagged reject, untagged reject and a cleared review', () => {
    expect(renderReviewDeltaLine(row({ reviewState: 'accepted' }))).toBe(
      '- Finding #4 "Race in parser" — ACCEPTED by the user.'
    )
    expect(
      renderReviewDeltaLine(
        row({ reviewState: 'rejected', rejectTag: 'wrong', rejectNote: 'old build' })
      )
    ).toBe('- Finding #4 "Race in parser" — REJECTED by the user (wrong: old build).')
    expect(renderReviewDeltaLine(row({ reviewState: 'rejected', rejectTag: 'not-useful' }))).toBe(
      '- Finding #4 "Race in parser" — REJECTED by the user (not-useful).'
    )
    expect(renderReviewDeltaLine(row({ reviewState: 'rejected' }))).toBe(
      '- Finding #4 "Race in parser" — REJECTED by the user (no reason given).'
    )
    expect(renderReviewDeltaLine(row({ reviewState: 'pending' }))).toBe(
      '- Finding #4 "Race in parser" — review cleared by the user (back to unreviewed).'
    )
  })
  it('honours a prompt override through resolve', () => {
    const resolve = (id: string): string =>
      id === 'turn.review-delta.accepted'
        ? 'ok #{id}'
        : REVIEW_DELTA_PROMPTS[id.replace('turn.review-delta.', '')].text
    expect(renderReviewDeltaLine(row({ reviewState: 'accepted' }), resolve)).toBe('ok #4')
  })
})

describe('ReviewDeltaQueue', () => {
  it('drains the preamble plus one line per finding, then forgets them', () => {
    const q = new ReviewDeltaQueue()
    q.note(row({ id: 4, reviewState: 'accepted' }))
    q.note(row({ id: 5, reviewState: 'rejected', rejectTag: 'wrong' }))
    const out = q.drain(1, 'investigation')
    expect(out.startsWith(REVIEW_DELTA_PROMPTS.preamble.text)).toBe(true)
    expect(out).toContain('- Finding #4 "Race in parser" — ACCEPTED by the user.')
    expect(out).toContain('- Finding #5 "Race in parser" — REJECTED by the user (wrong).')
    expect(out.endsWith('\n\n')).toBe(true)
    expect(q.drain(1, 'investigation')).toBe('')
  })
  it('collapses per finding: the last review wins', () => {
    const q = new ReviewDeltaQueue()
    q.note(row({ id: 4, reviewState: 'rejected' }))
    q.note(row({ id: 4, reviewState: 'accepted' }))
    const out = q.drain(1, 'investigation')
    expect(out.match(/Finding #4/g)).toHaveLength(1)
    expect(out).toContain('ACCEPTED')
  })
  it('scopes by case and by mode; returns empty with nothing queued', () => {
    const q = new ReviewDeltaQueue()
    q.note(row({ id: 4, caseId: 1, reviewState: 'accepted' }))
    q.note(row({ id: 9, caseId: 1, mode: 'review', reviewState: 'accepted' }))
    expect(q.drain(2, 'investigation')).toBe('')
    expect(q.drain(1, 'review')).toContain('#9')
    expect(q.drain(1, 'review')).toBe('')
    expect(q.drain(1, 'investigation')).toContain('#4')
  })
  it('clear drops everything for a case', () => {
    const q = new ReviewDeltaQueue()
    q.note(row({ id: 4, reviewState: 'accepted' }))
    q.note(row({ id: 9, mode: 'review', reviewState: 'accepted' }))
    q.clear(1)
    expect(q.drain(1, 'investigation')).toBe('')
    expect(q.drain(1, 'review')).toBe('')
  })
  it('clear with a mode drops only that mode', () => {
    const q = new ReviewDeltaQueue()
    q.note(row({ id: 4, reviewState: 'accepted' }))
    q.note(row({ id: 9, mode: 'review', reviewState: 'accepted' }))
    q.clear(1, 'investigation')
    expect(q.drain(1, 'investigation')).toBe('')
    expect(q.drain(1, 'review')).toContain('#9')
  })
  it('forget drops one finding and leaves the other', () => {
    const q = new ReviewDeltaQueue()
    q.note(row({ id: 4, reviewState: 'accepted' }))
    q.note(row({ id: 5, reviewState: 'accepted' }))
    q.forget(1, 4)
    q.forget(1, 99)
    q.forget(7, 4)
    const out = q.drain(1, 'investigation')
    expect(out).not.toContain('#4')
    expect(out).toContain('#5')
  })
})

describe('human chain edits', () => {
  it('renders the edit line from the current role and cause', () => {
    expect(
      renderReviewEditLine(row({ role: 'root-cause', causedBy: null, roleSource: 'human' }))
    ).toBe(
      '- Finding #4 "Race in parser" — the user set its role to root-cause and its cause to none.'
    )
    expect(renderReviewEditLine(row({ role: null, causedBy: 2 }))).toBe(
      '- Finding #4 "Race in parser" — the user set its role to none and its cause to #2.'
    )
  })
  it('queues an edit beside a review and drains one line per kind, once', () => {
    const q = new ReviewDeltaQueue()
    q.note(row({ id: 4, reviewState: 'accepted' }))
    q.note(row({ id: 4, reviewState: 'accepted', role: 'symptom', causedBy: 2 }), 'edit')
    q.note(row({ id: 5, role: 'contributing' }), 'edit')
    const out = q.drain(1, 'investigation')
    expect(out).toContain('- Finding #4 "Race in parser" — ACCEPTED by the user.')
    expect(out).toContain(
      '- Finding #4 "Race in parser" — the user set its role to symptom and its cause to #2.'
    )
    expect(out).toContain(
      '- Finding #5 "Race in parser" — the user set its role to contributing and its cause to none.'
    )
    expect(out.match(/Finding #4/g)).toHaveLength(2)
    expect(out).not.toContain('#5 "Race in parser" — ACCEPTED')
    expect(q.drain(1, 'investigation')).toBe('')
  })
  it('the preamble explains chain edits', () => {
    expect(REVIEW_DELTA_PROMPTS.preamble.text).toContain('set a role or cause')
  })
})
