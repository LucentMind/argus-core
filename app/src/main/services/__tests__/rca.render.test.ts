import { describe, it, expect } from 'vitest'
import type { CaseRcaInput, RcaDraft } from '../../../shared/rca'
import { renderExecReport, renderTechReport, templateFromSnapshot, toIdSet } from '../rca/render'
import { DEFAULT_RCA_TEMPLATE } from '../../../shared/rcaTemplate'
import type { RcaTemplate, RcaSection } from '../../../shared/rcaTemplate'

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
    ],
    sections: {}
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
    techNarrative: [],
    sections: {}
  }
}

describe('renderExecReport', () => {
  it('has no code refs, finding ids, or paths', () => {
    const md = renderExecReport(draft(), meta(), { template: DEFAULT_RCA_TEMPLATE })
    expect(md).toContain('# RCA — ')
    expect(md).not.toMatch(/finding \d|`[^`]+\.(ts|py|md)|\//)
    expect(md).toContain(draft().execSummary.whatBroke)
  })

  it('includes the Jira key as the only allowed reference', () => {
    const md = renderExecReport(draft(), meta(), { template: DEFAULT_RCA_TEMPLATE })
    expect(md).toContain('KAN-42')
  })

  it('omits the Jira line entirely when there is no Jira key', () => {
    const md = renderExecReport(
      draft(),
      { ...meta(), jiraKey: null },
      { template: DEFAULT_RCA_TEMPLATE }
    )
    expect(md).not.toContain('Jira')
  })

  it('skips empty sections with no placeholder noise', () => {
    const md = renderExecReport(emptyDraft(), meta(), { template: DEFAULT_RCA_TEMPLATE })
    expect(md).not.toMatch(/\(none\)/i)
  })

  it('reads execSummary.impact, not draft.impact, for the exec Impact section', () => {
    const md = renderExecReport(draft(), meta(), { template: DEFAULT_RCA_TEMPLATE })
    expect(md).toContain(draft().execSummary.impact)
    expect(md).not.toContain(draft().impact)
  })
})

describe('renderTechReport', () => {
  it('includes ruled-out whys and flattened citations', () => {
    const md = renderTechReport(draft(), meta(), { template: DEFAULT_RCA_TEMPLATE })
    expect(md).toContain('## Ruled out')
    expect(md).toContain('because the retry queue was empty')
    expect(md).toContain('`src/cache/key.ts:42`')
  })

  it('includes an evidence blockquote next to a citation with evidence text', () => {
    const md = renderTechReport(draft(), meta(), { template: DEFAULT_RCA_TEMPLATE })
    expect(md).toContain('> cache hit returned data for the wrong tenant')
  })

  it('includes an Impact section sourced from the top-level impact field', () => {
    const md = renderTechReport(draft(), meta(), { template: DEFAULT_RCA_TEMPLATE })
    expect(md).toContain('## Impact')
    expect(md).toContain(draft().impact)
  })

  it('reads draft.impact, not execSummary.impact, for the tech Impact section', () => {
    const md = renderTechReport(draft(), meta(), { template: DEFAULT_RCA_TEMPLATE })
    expect(md).toContain(draft().impact)
    expect(md).not.toContain(draft().execSummary.impact)
  })

  it('omits the Impact section when impact is empty', () => {
    const md = renderTechReport({ ...draft(), impact: '' }, meta(), {
      template: DEFAULT_RCA_TEMPLATE
    })
    expect(md).not.toContain('## Impact')
  })

  it('skips Contributing factors, Ruled out, and Narrative sections when empty, with no placeholder', () => {
    const md = renderTechReport(emptyDraft(), meta(), { template: DEFAULT_RCA_TEMPLATE })
    expect(md).not.toContain('## Contributing factors')
    expect(md).not.toContain('## Ruled out')
    expect(md).not.toMatch(/\(none\)/i)
  })

  it('skips Symptoms & timeline entirely when both are empty', () => {
    const md = renderTechReport(emptyDraft(), meta(), { template: DEFAULT_RCA_TEMPLATE })
    expect(md).not.toContain('Symptoms & timeline')
  })

  it('still renders the always-present Root cause and Remediation sections', () => {
    const md = renderTechReport(emptyDraft(), meta(), { template: DEFAULT_RCA_TEMPLATE })
    expect(md).toContain('## Root cause')
    expect(md).toContain('## Remediation')
  })
})

const DEFAULTS = { template: DEFAULT_RCA_TEMPLATE }

function clone(t: RcaTemplate): RcaTemplate {
  return JSON.parse(JSON.stringify(t)) as RcaTemplate
}

describe('golden snapshots (byte-identical guarantee)', () => {
  it('renders the exec report exactly as before, under the default template', () => {
    const md = renderExecReport(draft(), meta(), DEFAULTS)
    expect(md).toMatchInlineSnapshot(`
      "# RCA — Cross-tenant cache leak

      Jira: KAN-42

      ## What happened

      A caching bug briefly let some customers see another customer’s data.

      ## Impact

      A small number of customers may have seen another customer’s cached information for about 40 minutes.

      ## Root cause

      The system that builds cache keys did not include which customer the data belonged to.

      ## What we did

      Invalidated the shared cache and rolled back the deploy.

      ## Next steps

      - We fixed the cache key and are adding a test to prevent this from happening again.
      - Add the tenant id to the cache key composition.
      - Add an integration test for cross-tenant cache isolation."
    `)
  })

  it('renders the tech report exactly as before, under the default template', () => {
    const md = renderTechReport(draft(), meta(), DEFAULTS)
    expect(md).toMatchInlineSnapshot(`
      "# RCA — Cross-tenant cache leak

      Jira: KAN-42 · Case: case-a

      ## Root cause

      The cache key omitted the tenant id, causing collisions between tenants. (finding 7)

      \`src/cache/key.ts:42\`
      > cache hit returned data for the wrong tenant

      ## Impact

      Customers in the affected tenants received other tenants’ cached API responses for roughly 40 minutes.

      ## Contributing factors

      Retry logic multiplied writes under load, widening the collision window. (finding 3)

      \`src/worker/retry.ts:10\`

      ## Symptoms & timeline

      - Tenants intermittently saw other tenants’ cached responses. (finding 7)

      ### Timeline

      - 2026-01-01T10:00:00Z — Cache key collision begins after deploy of v2.3.0
      - 2026-01-01T10:40:00Z — Cache invalidated; incident resolved

      ## Ruled out

      - A stale connection pool was suspected. — because the retry queue was empty at the time of the incident

      ## Remediation

      Invalidated the shared cache and rolled back the deploy.

      ### Follow-ups

      - Add the tenant id to the cache key composition.
      - Add an integration test for cross-tenant cache isolation.

      ## Why the cache key collided

      The key builder concatenated only the endpoint and query parameters, so two tenants requesting the same endpoint with the same parameters landed on the same cache entry.

      \`src/cache/key.ts:42\`
      > key = \`\${endpoint}:\${params}\`"
    `)
  })
})

describe('template-driven rendering', () => {
  it('renders exec sections in template order', () => {
    const t = clone(DEFAULT_RCA_TEMPLATE)
    t.exec = [t.exec[2], t.exec[0]] // Root cause, then What happened
    const out = renderExecReport(draft(), meta(), { template: t })
    expect(out.indexOf('## Root cause')).toBeLessThan(out.indexOf('## What happened'))
    expect(out).not.toContain('## Impact')
    expect(out).not.toContain('## Next steps')
  })

  it('uses the template heading, not the built-in one', () => {
    const t = clone(DEFAULT_RCA_TEMPLATE)
    t.exec[0].heading = 'Summary of the outage'
    const out = renderExecReport(draft(), meta(), { template: t })
    expect(out).toContain('## Summary of the outage')
    expect(out).not.toContain('## What happened')
    // the body still comes from the same draft field
    expect(out).toContain('A caching bug briefly let some customers see another customer’s data.')
  })

  it('skips a disabled section', () => {
    const t = clone(DEFAULT_RCA_TEMPLATE)
    t.tech[4].enabled = false // Ruled out
    const out = renderTechReport(draft(), meta(), { template: t })
    expect(out).not.toContain('## Ruled out')
    expect(out).toContain('## Remediation')
  })

  it('skips a section named in `dropped` without changing the template', () => {
    const templateBefore = structuredClone(DEFAULT_RCA_TEMPLATE)
    const out = renderTechReport(draft(), meta(), {
      template: DEFAULT_RCA_TEMPLATE,
      dropped: new Set(['tech-impact'])
    })
    expect(out).not.toContain('## Impact')
    expect(out).toContain('## Root cause')
    expect(DEFAULT_RCA_TEMPLATE).toEqual(templateBefore)
  })

  it('splits symptoms and timeline when the template gives timeline its own section', () => {
    const t = clone(DEFAULT_RCA_TEMPLATE)
    t.tech[3].heading = 'Symptoms'
    t.tech.splice(4, 0, {
      id: 'timeline',
      heading: 'Timeline',
      kind: 'claims',
      slot: 'timeline',
      enabled: true
    })
    const out = renderTechReport(draft(), meta(), { template: t })
    expect(out).toContain('## Symptoms\n')
    expect(out).toContain('## Timeline\n')
    // the sub-heading form is only used when symptoms carries the timeline itself
    expect(out).not.toContain('### Timeline')
    expect(out.indexOf('## Symptoms')).toBeLessThan(out.indexOf('## Timeline'))
  })

  it('still emits the ### Timeline sub-block when symptoms owns it', () => {
    const out = renderTechReport(draft(), meta(), DEFAULTS)
    expect(out).toContain('### Timeline')
  })

  it('does not relocate the timeline into symptoms when its own section is disabled', () => {
    const t = clone(DEFAULT_RCA_TEMPLATE)
    t.tech[3].heading = 'Symptoms'
    t.tech.splice(4, 0, {
      id: 'timeline',
      heading: 'Timeline',
      kind: 'claims',
      slot: 'timeline',
      enabled: false
    })
    const out = renderTechReport(draft(), meta(), { template: t })
    expect(out).not.toContain('## Timeline')
    expect(out).not.toContain('### Timeline')
    expect(out).not.toContain('Cache key collision begins after deploy of v2.3.0')
  })

  it('does not relocate the timeline into symptoms when its own section is dropped', () => {
    const t = clone(DEFAULT_RCA_TEMPLATE)
    t.tech[3].heading = 'Symptoms'
    t.tech.splice(4, 0, {
      id: 'timeline',
      heading: 'Timeline',
      kind: 'claims',
      slot: 'timeline',
      enabled: true
    })
    const out = renderTechReport(draft(), meta(), {
      template: t,
      dropped: new Set(['timeline'])
    })
    expect(out).not.toContain('## Timeline')
    expect(out).not.toContain('### Timeline')
    expect(out).not.toContain('Cache key collision begins after deploy of v2.3.0')
  })

  it('throws a clear error for a claims section with an unknown slot, instead of crashing later', () => {
    const t = clone(DEFAULT_RCA_TEMPLATE)
    t.tech[0] = {
      id: 'tech-root-cause',
      heading: 'Root cause',
      kind: 'claims',
      slot: 'not-a-real-slot' as unknown as RcaSection['slot'],
      enabled: true
    }
    expect(() => renderTechReport(draft(), meta(), { template: t })).toThrow(
      /unknown claim slot: not-a-real-slot/
    )
  })
})

describe('narrative bodies resolve from the section id alone', () => {
  it('exec Impact and tech Impact read different draft fields with no report-specific branch', () => {
    // Both Impact sections placed in the SAME list: nothing but the id can tell them apart, so
    // this fails if the exec/tech distinction lives in a renderer branch instead of in the ids.
    const t = clone(DEFAULT_RCA_TEMPLATE)
    const execImpact = t.exec.find((s) => s.heading === 'Impact')!
    const techImpact = t.tech.find((s) => s.heading === 'Impact')!
    t.exec = [execImpact, { ...techImpact, heading: 'Technical impact' }]
    const out = renderExecReport(draft(), meta(), { template: t })
    expect(out).toContain(draft().execSummary.impact)
    expect(out).toContain(draft().impact)
  })
})

describe('model-authored sections', () => {
  it('prefers draft.sections over the legacy field for the same id', () => {
    const d = draft()
    d.sections = { 'exec-what-happened': { body: 'Model-authored text.', citations: [] } }
    const out = renderExecReport(d, meta(), DEFAULTS)
    expect(out).toContain('Model-authored text.')
    expect(out).not.toContain(d.execSummary.whatBroke)
  })

  it('falls back to the legacy field when the id is absent from sections', () => {
    const d = draft()
    d.sections = {}
    expect(renderExecReport(d, meta(), DEFAULTS)).toContain(d.execSummary.whatBroke)
  })

  it('falls back when the section is present but its body is empty', () => {
    const d = draft()
    d.sections = { 'exec-what-happened': { body: '   ', citations: [] } }
    expect(renderExecReport(d, meta(), DEFAULTS)).toContain(d.execSummary.whatBroke)
  })

  it('renders a user-added section that has no legacy field', () => {
    const t = clone(DEFAULT_RCA_TEMPLATE)
    t.tech.push({
      id: 'tech-detection',
      heading: 'Detection',
      kind: 'narrative',
      enabled: true,
      instruction: 'x'
    })
    const d = draft()
    d.sections = {
      'tech-detection': { body: 'Alerted by the p99 latency monitor.', citations: [] }
    }
    const out = renderTechReport(d, meta(), { template: t })
    expect(out).toContain('## Detection')
    expect(out).toContain('Alerted by the p99 latency monitor.')
  })

  it('renders a tech section citation but never an exec one', () => {
    const t = clone(DEFAULT_RCA_TEMPLATE)
    const d = draft()
    d.sections = {
      'tech-impact': { body: 'Blast radius.', citations: [{ path: 'src/a.ts', line: 3 }] },
      'exec-impact': { body: 'Business impact.', citations: [{ path: 'src/a.ts', line: 3 }] }
    }
    expect(renderTechReport(d, meta(), { template: t })).toContain('`src/a.ts:3`')
    expect(renderExecReport(d, meta(), { template: t })).not.toContain('src/a.ts')
  })
})

describe('templateFromSnapshot', () => {
  it('returns the default for null, undefined, and malformed json', () => {
    expect(templateFromSnapshot(null)).toEqual(DEFAULT_RCA_TEMPLATE)
    expect(templateFromSnapshot(undefined)).toEqual(DEFAULT_RCA_TEMPLATE)
    expect(templateFromSnapshot('{not json')).toEqual(DEFAULT_RCA_TEMPLATE)
  })

  it('returns the default for a structurally invalid snapshot (e.g. JSON null)', () => {
    expect(templateFromSnapshot('null')).toEqual(DEFAULT_RCA_TEMPLATE)
    expect(templateFromSnapshot('42')).toEqual(DEFAULT_RCA_TEMPLATE)
    expect(templateFromSnapshot('{"exec": []}')).toEqual(DEFAULT_RCA_TEMPLATE)
  })

  it('returns the snapshotted template', () => {
    const t = clone(DEFAULT_RCA_TEMPLATE)
    t.exec[0].heading = 'Overview'
    expect(templateFromSnapshot(JSON.stringify(t)).exec[0].heading).toBe('Overview')
  })

  it('never returns the shared DEFAULT_RCA_TEMPLATE singleton on a fallback path', () => {
    const result = templateFromSnapshot(null)
    result.exec[0].heading = 'mutated'
    expect(DEFAULT_RCA_TEMPLATE.exec[0].heading).not.toBe('mutated')
  })
})

describe('per-report dropped sections (no cross-report collision)', () => {
  it('dropping the exec Impact leaves the tech Impact present', () => {
    // Mirrors what the rca:render-preview handler does: one resolved template, two
    // independently-scoped `dropped` sets built from `{ exec?: string[]; tech?: string[] }`.
    const execOpts = { template: DEFAULT_RCA_TEMPLATE, dropped: new Set<string>(['exec-impact']) }
    const techOpts = { template: DEFAULT_RCA_TEMPLATE, dropped: new Set<string>() }
    const exec = renderExecReport(draft(), meta(), execOpts)
    const tech = renderTechReport(draft(), meta(), techOpts)
    expect(exec).not.toContain('## Impact')
    expect(tech).toContain('## Impact')
  })
})

describe('toIdSet', () => {
  it('passes through an array of strings', () => {
    expect(toIdSet(['impact', 'root-cause'])).toEqual(new Set(['impact', 'root-cause']))
  })

  it('drops non-string entries from an otherwise valid array', () => {
    expect(toIdSet(['impact', 42, null, {}, 'root-cause'])).toEqual(
      new Set(['impact', 'root-cause'])
    )
  })

  it('falls back to an empty set for undefined, null, and non-array values', () => {
    expect(toIdSet(undefined)).toEqual(new Set())
    expect(toIdSet(null)).toEqual(new Set())
    expect(toIdSet('impact')).toEqual(new Set())
    expect(toIdSet({ exec: ['impact'] })).toEqual(new Set())
    expect(toIdSet(42)).toEqual(new Set())
  })
})
