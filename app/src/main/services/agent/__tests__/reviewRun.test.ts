import { describe, it, expect } from 'vitest'
import { buildReviewRunPrompt } from '../reviewRun'
import { REVIEW_LAYERS } from '../../../../shared/reviewLayers'

const base = {
  prUrl: 'https://github.com/o/r/pull/7',
  worktreePath: '/wt/r-case-pr7'
}

describe('buildReviewRunPrompt', () => {
  it('names the PR and the worktree', () => {
    const p = buildReviewRunPrompt({ ...base, support: 'configurable', pinnedLayers: [] })
    expect(p).toContain('https://github.com/o/r/pull/7')
    expect(p).toContain('/wt/r-case-pr7')
  })

  it('on a configurable driver delegates by agent name and does not inline layer prompts', () => {
    const p = buildReviewRunPrompt({ ...base, support: 'configurable', pinnedLayers: [] })
    expect(p).toContain('review-correctness')
    expect(p).toContain('review-design-conformance')
    expect(p).not.toContain(REVIEW_LAYERS.correctness.prompt)
  })

  it('on a promptable driver inlines each layer prompt', () => {
    const p = buildReviewRunPrompt({ ...base, support: 'promptable', pinnedLayers: [] })
    expect(p).toContain(REVIEW_LAYERS.correctness.prompt)
    expect(p).toContain(REVIEW_LAYERS.security.prompt)
  })

  it('lets the agent choose when nothing is pinned', () => {
    const p = buildReviewRunPrompt({ ...base, support: 'configurable', pinnedLayers: [] })
    expect(p).toContain(REVIEW_LAYERS.security.appliesWhen)
  })

  it('restricts to the pinned layers and says they were chosen by the user', () => {
    const p = buildReviewRunPrompt({
      ...base,
      support: 'configurable',
      pinnedLayers: ['security']
    })
    expect(p).toContain('review-security')
    expect(p).not.toContain('review-tests')
    expect(p).toMatch(/user (pinned|selected|asked)/i)
  })

  it('always carries the triage contract', () => {
    for (const support of ['configurable', 'promptable'] as const) {
      const p = buildReviewRunPrompt({ ...base, support, pinnedLayers: [] })
      expect(p).toMatch(/dedup/i)
      expect(p).toMatch(/refute/i)
      expect(p).toMatch(/append_finding/)
    }
  })

  it('routes its own scaffolding through the resolver', () => {
    const seen: string[] = []
    buildReviewRunPrompt({
      ...base,
      support: 'configurable',
      pinnedLayers: [],
      resolve: (id) => {
        seen.push(id)
        return 'X'
      }
    })
    expect(seen).toContain('review.run.header')
    expect(seen).toContain('review.run.triage')
  })
})
