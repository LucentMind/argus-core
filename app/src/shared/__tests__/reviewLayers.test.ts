import { describe, it, expect } from 'vitest'
import {
  REVIEW_LAYERS,
  REVIEW_LAYER_ORDER,
  isReviewLayerId,
  isReviewSeverity,
  SEVERITIES
} from '../reviewLayers'

describe('review layer registry', () => {
  it('ships the four spec layers in declaration order', () => {
    expect(REVIEW_LAYER_ORDER).toEqual(['correctness', 'security', 'tests', 'design-conformance'])
  })

  it('derives the order from REVIEW_LAYERS rather than a hand-kept list', () => {
    expect(REVIEW_LAYER_ORDER).toEqual(Object.keys(REVIEW_LAYERS))
  })

  it('gives every layer a label, an applicability line, a persona and a prompt', () => {
    for (const id of REVIEW_LAYER_ORDER) {
      const def = REVIEW_LAYERS[id]
      expect(def.id).toBe(id)
      expect(def.label.length).toBeGreaterThan(0)
      expect(def.appliesWhen.length).toBeGreaterThan(0)
      expect(def.personaFragment.length).toBeGreaterThan(0)
      expect(def.prompt.length).toBeGreaterThan(0)
    }
  })

  it('guards layer ids', () => {
    expect(isReviewLayerId('security')).toBe(true)
    expect(isReviewLayerId('vibes')).toBe(false)
    expect(isReviewLayerId(null)).toBe(false)
  })

  it('guards severities against the persona vocabulary', () => {
    expect(SEVERITIES).toEqual(['critical', 'major', 'minor'])
    expect(isReviewSeverity('major')).toBe(true)
    expect(isReviewSeverity('nit')).toBe(false)
  })
})
