import { describe, it, expect } from 'vitest'
import { subagentsForSession } from '../session'
import { REVIEW_LAYER_ORDER } from '../../../../shared/reviewLayers'

describe('subagentsForSession', () => {
  it('is empty in investigation mode even on a configurable driver', () => {
    expect(subagentsForSession('investigation', 'configurable')).toEqual([])
  })

  it('is empty on a promptable driver even in review mode', () => {
    expect(subagentsForSession('review', 'promptable')).toEqual([])
  })

  it('compiles every layer in review mode on a configurable driver', () => {
    const defs = subagentsForSession('review', 'configurable')
    expect(defs.map((d) => d.name)).toEqual(REVIEW_LAYER_ORDER.map((id) => `review-${id}`))
  })

  it('routes layer text through the session resolver', () => {
    const defs = subagentsForSession('review', 'configurable', (id) => `X:${id}`)
    expect(defs[0].prompt).toContain('X:review.layer.correctness.persona')
  })
})
