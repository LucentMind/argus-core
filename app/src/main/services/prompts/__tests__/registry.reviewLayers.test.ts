import { describe, it, expect } from 'vitest'
import { PROMPT_ENTRIES } from '../registry'
import { REVIEW_LAYERS, REVIEW_LAYER_ORDER } from '../../../../shared/reviewLayers'

describe('review layer prompt entries', () => {
  it('registers a persona and a prompt entry per layer', () => {
    const ids = PROMPT_ENTRIES.map((e) => e.id)
    for (const layer of REVIEW_LAYER_ORDER) {
      expect(ids).toContain(`review.layer.${layer}.persona`)
      expect(ids).toContain(`review.layer.${layer}.prompt`)
    }
  })

  it('resolves each default to the registry text, read at call time', () => {
    const entry = PROMPT_ENTRIES.find((e) => e.id === 'review.layer.security.prompt')
    expect(entry).toBeDefined()
    expect(entry!.default()).toBe(REVIEW_LAYERS.security.prompt)
    expect(entry!.editable).toBe(true)
    expect(entry!.reaches).toBe('all')
  })

  it('keeps every entry id unique', () => {
    const ids = PROMPT_ENTRIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
