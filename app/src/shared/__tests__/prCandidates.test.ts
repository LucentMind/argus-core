import { describe, it, expect } from 'vitest'
import { classifyCandidates, type RawPrHit } from '../pr'

const hit = (o: Partial<RawPrHit> & Pick<RawPrHit, 'number' | 'state' | 'title'>): RawPrHit => ({
  isDraft: false,
  createdAt: '2026-07-21T10:00:00Z',
  url: `https://github.com/JiaweiHan88/HiveMindTest/pull/${o.number}`,
  repository: { nameWithOwner: 'JiaweiHan88/HiveMindTest' },
  ...o
})

// The real NN-5165 result set, captured 2026-07-26.
const NN_5165: RawPrHit[] = [
  hit({
    number: 16311,
    state: 'closed',
    title: '[NN-5165] Fix alternatives fork-passed check ignoring leg index'
  }),
  hit({
    number: 16315,
    state: 'merged',
    title:
      '[NN-5165] Fix alternatives fork-passed check discarding the initial route on multi-leg routes'
  }),
  hit({
    number: 16395,
    state: 'merged',
    createdAt: '2026-07-22T09:00:00Z',
    title:
      '[Backport release/v0.27] [NN-5165] Fix alternatives fork-passed check discarding the initial route on multi-leg routes'
  }),
  hit({
    number: 16439,
    state: 'merged',
    createdAt: '2026-07-22T09:30:00Z',
    title:
      '[Backport release/v0.26] [NN-5165] Fix alternatives fork-passed check discarding the initial route on multi-leg routes'
  })
]

describe('classifyCandidates', () => {
  it('hides closed-unmerged, shows the rest, pre-selects only non-backports', () => {
    const out = classifyCandidates(NN_5165)
    expect(out.map((c) => c.number)).toEqual([16315, 16395, 16439])
    expect(out.filter((c) => c.preselected).map((c) => c.number)).toEqual([16315])
    expect(out.find((c) => c.number === 16395)?.isBackport).toBe(true)
    expect(out.find((c) => c.number === 16315)?.isBackport).toBe(false)
  })

  it('splits owner/repo out of nameWithOwner and keeps the url', () => {
    const [first] = classifyCandidates(NN_5165)
    expect(first.owner).toBe('JiaweiHan88')
    expect(first.repo).toBe('HiveMindTest')
    expect(first.url).toBe('https://github.com/JiaweiHan88/HiveMindTest/pull/16315')
  })

  it('keeps an open PR and preserves draft state without letting it affect selection', () => {
    const out = classifyCandidates([
      hit({ number: 1, state: 'open', isDraft: true, title: '[AB-1] work in progress' })
    ])
    expect(out).toHaveLength(1)
    expect(out[0].isDraft).toBe(true)
    expect(out[0].preselected).toBe(true)
  })

  it('pre-selects every non-backport when there are several', () => {
    const out = classifyCandidates([
      hit({ number: 1, state: 'open', title: '[AB-1] part one' }),
      hit({ number: 2, state: 'merged', title: '[AB-1] part two' })
    ])
    expect(out.filter((c) => c.preselected)).toHaveLength(2)
  })

  it('returns an empty list when everything is closed-unmerged', () => {
    expect(classifyCandidates([hit({ number: 9, state: 'closed', title: '[AB-1] nope' })])).toEqual(
      []
    )
  })
})
