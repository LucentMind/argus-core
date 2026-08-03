import { describe, it, expect } from 'vitest'
import { validateRcaDraft } from '../rca/parse'
import type { RcaDraft } from '../../../shared/rca'

function validDraft(): RcaDraft {
  return {
    rootCause: {
      findingId: 1,
      statement: 'the cache key omitted the tenant id',
      evidence: [{ path: 'logs/app.log', line: 12, evidence: 'cache hit for wrong tenant' }]
    },
    contributing: [],
    symptoms: [],
    ruledOut: [],
    duplicates: [],
    impact: 'cross-tenant data leak in cached responses',
    timeline: [],
    remediation: { immediate: 'invalidate cache', followUps: ['add tenant id to cache key'] },
    execSummary: {
      whatBroke: 'cached data leaked between tenants',
      impact: 'customers saw other tenants data',
      why: 'the cache key omitted the tenant id',
      nextSteps: 'add tenant id to the cache key'
    },
    techNarrative: []
  }
}

describe('validateRcaDraft', () => {
  it('returns a valid draft unchanged', () => {
    const d = validDraft()
    expect(validateRcaDraft(d)).toEqual(d)
  })

  it('rejects a draft missing required fields', () => {
    const rest: Record<string, unknown> = { ...validDraft() }
    delete rest.rootCause
    expect(() => validateRcaDraft(rest)).toThrow()
  })

  it('rejects a non-object payload', () => {
    expect(() => validateRcaDraft('not a draft')).toThrow()
    expect(() => validateRcaDraft(null)).toThrow()
  })

  it('rejects an empty techNarrative heading', () => {
    const d = validDraft()
    d.techNarrative = [{ heading: '', body: 'body text', citations: [] }]
    expect(() => validateRcaDraft(d)).toThrow()
  })

  it('accepts a non-empty techNarrative heading', () => {
    const d = validDraft()
    d.techNarrative = [{ heading: 'Root cause analysis', body: 'body text', citations: [] }]
    expect(() => validateRcaDraft(d)).not.toThrow()
  })
})
