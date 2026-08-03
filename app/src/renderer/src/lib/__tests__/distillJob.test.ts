import { describe, it, expect } from 'vitest'
import { distillMenuLabel, isDistillInFlight } from '../distillJob'
import type { DistillJobRow } from '../../../../shared/distill'

const job = (over: Partial<DistillJobRow>): DistillJobRow => ({
  id: 1,
  caseSlug: 'NN-1',
  state: 'done',
  error: null,
  itemCount: null,
  createdAt: 't',
  finishedAt: null,
  ...over
})

describe('distillMenuLabel', () => {
  it('reads Distill when no job has ever run', () => {
    expect(distillMenuLabel(null)).toBe('Distill')
  })

  it('reads Cancel distillation while queued or running', () => {
    expect(distillMenuLabel(job({ state: 'queued' }))).toBe('Cancel distillation')
    expect(distillMenuLabel(job({ state: 'running' }))).toBe('Cancel distillation')
  })

  it('reads Re-distill with the item count when done', () => {
    expect(distillMenuLabel(job({ state: 'done', itemCount: 3 }))).toBe('Re-distill · 3 items')
    expect(distillMenuLabel(job({ state: 'done', itemCount: 0 }))).toBe(
      'Re-distill · nothing to distill'
    )
  })

  it('reads plain Re-distill after a failure or a cancel', () => {
    expect(distillMenuLabel(job({ state: 'failed' }))).toBe('Re-distill')
    expect(distillMenuLabel(job({ state: 'cancelled' }))).toBe('Re-distill')
  })
})

describe('isDistillInFlight', () => {
  it('is true only for queued and running', () => {
    expect(isDistillInFlight(job({ state: 'queued' }))).toBe(true)
    expect(isDistillInFlight(job({ state: 'running' }))).toBe(true)
    expect(isDistillInFlight(job({ state: 'done' }))).toBe(false)
    expect(isDistillInFlight(job({ state: 'cancelled' }))).toBe(false)
    expect(isDistillInFlight(null)).toBe(false)
  })
})
