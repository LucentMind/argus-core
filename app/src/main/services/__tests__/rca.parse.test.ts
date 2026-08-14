import { describe, it, expect } from 'vitest'
import { expectedSectionIds, parseRcaOutput, validateRcaDraft, RcaParseError } from '../rca/parse'
import type { RcaDraft } from '../../../shared/rca'
import { DEFAULT_RCA_TEMPLATE } from '../../../shared/rcaTemplate'

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
    techNarrative: [],
    sections: {}
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

function fence(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```'
}

/** Minimal well-formed draft; `sections` filled per test. */
function base(sections: Record<string, unknown>): Record<string, unknown> {
  return {
    rootCause: { findingId: null, statement: 'rc', evidence: [] },
    contributing: [],
    symptoms: [],
    ruledOut: [],
    duplicates: [],
    impact: '',
    timeline: [],
    remediation: { immediate: '', followUps: [] },
    execSummary: { whatBroke: '', impact: '', why: '', nextSteps: '' },
    techNarrative: [],
    sections
  }
}

describe('expectedSectionIds', () => {
  it('lists enabled narrative ids, exec before tech, in template order', () => {
    expect(expectedSectionIds(DEFAULT_RCA_TEMPLATE)).toEqual([
      'exec-what-happened',
      'exec-impact',
      'exec-root-cause',
      'exec-what-we-did',
      'exec-next-steps',
      'tech-impact'
    ])
  })

  it('excludes disabled sections and claims sections', () => {
    const t = structuredClone(DEFAULT_RCA_TEMPLATE)
    t.exec[0].enabled = false
    expect(expectedSectionIds(t)).not.toContain('exec-what-happened')
    expect(expectedSectionIds(t)).not.toContain('tech-root-cause')
  })
})

describe('parseRcaOutput sections', () => {
  it('accepts a draft carrying every expected id', () => {
    const sections = Object.fromEntries(
      expectedSectionIds(DEFAULT_RCA_TEMPLATE).map((id) => [
        id,
        { body: `body of ${id}`, citations: [] }
      ])
    )
    const d = parseRcaOutput(fence(base(sections)), expectedSectionIds(DEFAULT_RCA_TEMPLATE))
    expect(d.sections['exec-impact'].body).toBe('body of exec-impact')
  })

  it('names the missing key when one expected section is absent', () => {
    const ids = expectedSectionIds(DEFAULT_RCA_TEMPLATE)
    const sections = Object.fromEntries(
      ids.filter((id) => id !== 'exec-root-cause').map((id) => [id, { body: 'x', citations: [] }])
    )
    expect(() => parseRcaOutput(fence(base(sections)), ids)).toThrow(/exec-root-cause/)
  })

  it('preserves raw output on a missing-section failure so the panel can show it', () => {
    const raw = fence(base({}))
    try {
      parseRcaOutput(raw, ['exec-impact'])
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(RcaParseError)
      expect((e as RcaParseError).raw).toBe(raw)
    }
  })

  it('tolerates extra keys the template did not ask for', () => {
    const d = parseRcaOutput(
      fence(
        base({ 'exec-impact': { body: 'a', citations: [] }, spare: { body: 'b', citations: [] } })
      ),
      ['exec-impact']
    )
    expect(d.sections.spare.body).toBe('b')
  })

  it('defaults sections to {} and skips the id check when no expected list is given', () => {
    const obj = base({})
    delete obj.sections
    const d = parseRcaOutput(fence(obj))
    expect(d.sections).toEqual({})
  })

  it('rejects a section whose body is not a string', () => {
    expect(() =>
      parseRcaOutput(fence(base({ 'exec-impact': { body: 42, citations: [] } })), ['exec-impact'])
    ).toThrow()
  })
})

describe('validateRcaDraft sections', () => {
  it('applies the same expected-id check at the IPC boundary', () => {
    expect(() => validateRcaDraft(base({}), ['exec-impact'])).toThrow(/exec-impact/)
  })
})
