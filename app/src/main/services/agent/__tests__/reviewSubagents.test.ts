import { describe, it, expect } from 'vitest'
import { compileLayerAgents } from '../reviewSubagents'
import { REVIEW_LAYERS, REVIEW_LAYER_ORDER } from '../../../../shared/reviewLayers'

describe('compileLayerAgents', () => {
  it('names each agent review-<layerId>', () => {
    const defs = compileLayerAgents(REVIEW_LAYER_ORDER)
    expect(defs.map((d) => d.name)).toEqual([
      'review-correctness',
      'review-security',
      'review-tests',
      'review-design-conformance'
    ])
  })

  it('composes persona then task into one prompt', () => {
    const [correctness] = compileLayerAgents(['correctness'])
    expect(correctness.prompt).toContain(REVIEW_LAYERS.correctness.personaFragment)
    expect(correctness.prompt).toContain(REVIEW_LAYERS.correctness.prompt)
    expect(correctness.prompt.indexOf(REVIEW_LAYERS.correctness.personaFragment)).toBeLessThan(
      correctness.prompt.indexOf(REVIEW_LAYERS.correctness.prompt)
    )
  })

  it('carries the applicability line as the description so the main agent can choose', () => {
    const [security] = compileLayerAgents(['security'])
    expect(security.description).toBe(REVIEW_LAYERS.security.appliesWhen)
  })

  it('grants read-only tool kinds and never a findings or write tool', () => {
    for (const def of compileLayerAgents(REVIEW_LAYER_ORDER)) {
      expect(def.tools).toEqual(['read', 'search', 'execute'])
      expect(def.tools).not.toContain('write')
    }
  })

  it('routes every string through the resolver when one is given', () => {
    const seen: string[] = []
    const resolve = (id: string): string => {
      seen.push(id)
      return `OVERRIDDEN:${id}`
    }
    const [def] = compileLayerAgents(['tests'], resolve)
    expect(seen).toEqual(['review.layer.tests.persona', 'review.layer.tests.prompt'])
    expect(def.prompt).toContain('OVERRIDDEN:review.layer.tests.persona')
    expect(def.prompt).toContain('OVERRIDDEN:review.layer.tests.prompt')
  })

  it('preserves the caller order and drops nothing', () => {
    const defs = compileLayerAgents(['tests', 'correctness'])
    expect(defs.map((d) => d.name)).toEqual(['review-tests', 'review-correctness'])
  })
})
