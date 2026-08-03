import { describe, it, expect } from 'vitest'
import type { CaseRcaInput, RcaDraft } from '../../../shared/rca'
import { renderExecReport, renderTechReport } from '../rca/render'

function meta(): CaseRcaInput['caseMeta'] {
  return {
    slug: 'case-a',
    title: 'Cross-tenant cache leak',
    jiraKey: 'KAN-42',
    resolution: 'fixed',
    tags: ['perf', 'security'],
    createdAt: '2026-01-01'
  }
}

function draft(): RcaDraft {
  return {
    rootCause: {
      findingId: 7,
      statement: 'The cache key omitted the tenant id, causing collisions between tenants.',
      evidence: [
        {
          path: 'src/cache/key.ts',
          line: 42,
          evidence: 'cache hit returned data for the wrong tenant'
        }
      ]
    },
    contributing: [
      {
        findingId: 3,
        statement: 'Retry logic multiplied writes under load, widening the collision window.',
        evidence: [{ path: 'src/worker/retry.ts', line: 10 }]
      }
    ],
    symptoms: [
      { findingId: 7, statement: 'Tenants intermittently saw other tenants’ cached responses.' }
    ],
    ruledOut: [
      {
        findingId: null,
        statement: 'A stale connection pool was suspected.',
        why: 'because the retry queue was empty at the time of the incident'
      }
    ],
    duplicates: [],
    impact:
      'Customers in the affected tenants received other tenants’ cached API responses for roughly 40 minutes.',
    timeline: [
      { at: '2026-01-01T10:00:00Z', what: 'Cache key collision begins after deploy of v2.3.0' },
      { at: '2026-01-01T10:40:00Z', what: 'Cache invalidated; incident resolved' }
    ],
    remediation: {
      immediate: 'Invalidated the shared cache and rolled back the deploy.',
      followUps: [
        'Add the tenant id to the cache key composition.',
        'Add an integration test for cross-tenant cache isolation.'
      ]
    },
    execSummary: {
      whatBroke: 'A caching bug briefly let some customers see another customer’s data.',
      impact:
        'A small number of customers may have seen another customer’s cached information for about 40 minutes.',
      why: 'The system that builds cache keys did not include which customer the data belonged to.',
      nextSteps:
        'We fixed the cache key and are adding a test to prevent this from happening again.'
    },
    techNarrative: [
      {
        heading: 'Why the cache key collided',
        body: 'The key builder concatenated only the endpoint and query parameters, so two tenants requesting the same endpoint with the same parameters landed on the same cache entry.',
        citations: [
          { path: 'src/cache/key.ts', line: 42, evidence: 'key = `${endpoint}:${params}`' }
        ]
      }
    ]
  }
}

function emptyDraft(): RcaDraft {
  return {
    rootCause: {
      findingId: null,
      statement: 'Insufficient evidence to confirm a root cause.',
      evidence: []
    },
    contributing: [],
    symptoms: [],
    ruledOut: [],
    duplicates: [],
    impact: 'Impact could not be determined.',
    timeline: [],
    remediation: { immediate: 'No remediation applied yet.', followUps: [] },
    execSummary: {
      whatBroke: 'Investigation is ongoing.',
      impact: 'Impact is still being assessed.',
      why: 'The root cause has not been confirmed yet.',
      nextSteps: 'Continue the investigation.'
    },
    techNarrative: []
  }
}

describe('renderExecReport', () => {
  it('has no code refs, finding ids, or paths', () => {
    const md = renderExecReport(draft(), meta())
    expect(md).toContain('# RCA — ')
    expect(md).not.toMatch(/finding \d|`[^`]+\.(ts|py|md)|\//)
    expect(md).toContain(draft().execSummary.whatBroke)
  })

  it('includes the Jira key as the only allowed reference', () => {
    const md = renderExecReport(draft(), meta())
    expect(md).toContain('KAN-42')
  })

  it('omits the Jira line entirely when there is no Jira key', () => {
    const md = renderExecReport(draft(), { ...meta(), jiraKey: null })
    expect(md).not.toContain('Jira')
  })

  it('skips empty sections with no placeholder noise', () => {
    const md = renderExecReport(emptyDraft(), meta())
    expect(md).not.toMatch(/\(none\)/i)
  })
})

describe('renderTechReport', () => {
  it('includes ruled-out whys and flattened citations', () => {
    const md = renderTechReport(draft(), meta())
    expect(md).toContain('## Ruled out')
    expect(md).toContain('because the retry queue was empty')
    expect(md).toContain('`src/cache/key.ts:42`')
  })

  it('includes an evidence blockquote next to a citation with evidence text', () => {
    const md = renderTechReport(draft(), meta())
    expect(md).toContain('> cache hit returned data for the wrong tenant')
  })

  it('includes an Impact section sourced from the top-level impact field', () => {
    const md = renderTechReport(draft(), meta())
    expect(md).toContain('## Impact')
    expect(md).toContain(draft().impact)
  })

  it('omits the Impact section when impact is empty', () => {
    const md = renderTechReport({ ...draft(), impact: '' }, meta())
    expect(md).not.toContain('## Impact')
  })

  it('skips Contributing factors, Ruled out, and Narrative sections when empty, with no placeholder', () => {
    const md = renderTechReport(emptyDraft(), meta())
    expect(md).not.toContain('## Contributing factors')
    expect(md).not.toContain('## Ruled out')
    expect(md).not.toMatch(/\(none\)/i)
  })

  it('skips Symptoms & timeline entirely when both are empty', () => {
    const md = renderTechReport(emptyDraft(), meta())
    expect(md).not.toContain('Symptoms & timeline')
  })

  it('still renders the always-present Root cause and Remediation sections', () => {
    const md = renderTechReport(emptyDraft(), meta())
    expect(md).toContain('## Root cause')
    expect(md).toContain('## Remediation')
  })
})
