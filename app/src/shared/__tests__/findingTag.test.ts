import { describe, it, expect } from 'vitest'
import { reviewTag } from '../findingTag'

describe('reviewTag', () => {
  it('passes accepted and pending through', () => {
    expect(reviewTag({ reviewState: 'accepted' })).toBe('accepted')
    expect(reviewTag({ reviewState: 'pending' })).toBe('pending')
  })
  it('renders an agent retraction with its reason (unchanged)', () => {
    expect(reviewTag({ reviewState: 'rejected', reviewActor: 'agent', reviewReason: 'why' })).toBe(
      'rejected · retracted by agent: why'
    )
    expect(reviewTag({ reviewState: 'rejected', reviewActor: 'agent' })).toBe(
      'rejected · retracted by agent'
    )
  })
  it('renders a tagged human reject with and without a note', () => {
    expect(
      reviewTag({
        reviewState: 'rejected',
        reviewActor: 'human',
        rejectTag: 'wrong',
        rejectNote: 'old build'
      })
    ).toBe('rejected · wrong: old build')
    expect(
      reviewTag({ reviewState: 'rejected', reviewActor: 'human', rejectTag: 'not-useful' })
    ).toBe('rejected · not-useful')
  })
  it('renders an untagged human reject (and a legacy NULL actor) as bare rejected', () => {
    expect(reviewTag({ reviewState: 'rejected', reviewActor: 'human' })).toBe('rejected')
    expect(reviewTag({ reviewState: 'rejected', reviewActor: null, reviewReason: 'stale' })).toBe(
      'rejected'
    )
  })
  it('a human reject over an agent retraction shows the human tag, not the agent reason', () => {
    expect(
      reviewTag({
        reviewState: 'rejected',
        reviewActor: 'human',
        reviewReason: 'agent text',
        rejectTag: 'other',
        rejectNote: 'n'
      })
    ).toBe('rejected · other: n')
  })
})
