import { describe, it, expect } from 'vitest'
import { distillMenuLabel } from '../distillJob'
import type { DistillJobRow } from '../../../../shared/distill'

function job(overrides: Partial<DistillJobRow>): DistillJobRow {
  return { id: 1, caseSlug: 'nn-5187', state: 'done', itemCount: 0, ...overrides } as DistillJobRow
}

describe('distillMenuLabel', () => {
  it('is bare when no job has ever run', () => {
    expect(distillMenuLabel(null)).toBe('Re-distill')
  })

  it('carries the item count for a completed distillation', () => {
    expect(distillMenuLabel(job({ state: 'done', itemCount: 12 }))).toBe('Re-distill · 12 items')
  })

  it('says so when a completed run produced nothing', () => {
    expect(distillMenuLabel(job({ state: 'done', itemCount: 0 }))).toBe(
      'Re-distill · nothing to distill'
    )
  })

  it('stays bare while running — the bar chip is carrying that state', () => {
    expect(distillMenuLabel(job({ state: 'running' }))).toBe('Re-distill')
  })

  it('stays bare on failure — the bar keeps the retry affordance', () => {
    expect(distillMenuLabel(job({ state: 'failed' }))).toBe('Re-distill')
  })
})
