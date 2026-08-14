import { describe, it, expect } from 'vitest'
import type { CaseRcaInput, RcaDraft } from '../../../shared/rca'
import { buildCaseRcaPrompt, RCA_SECTIONS } from '../rca/contract'
import { parseRcaOutput, RcaParseError } from '../rca/parse'
import { caseRcaPromptHash } from '../rca/promptHash'
import { DEFAULT_RCA_TEMPLATE } from '../../../shared/rcaTemplate'

function minimalInput(): CaseRcaInput {
  return {
    caseMeta: {
      slug: 'case-a',
      title: 'Case A',
      jiraKey: 'KAN-1',
      resolution: 'solved',
      tags: ['perf'],
      createdAt: '2026-01-01'
    },
    findings: [
      {
        id: 7,
        summary: 'cache key omits tenant id',
        body: 'the cache key does not include tenant id, causing collisions',
        reviewState: 'accepted',
        role: 'root-cause'
      }
    ],
    evidence: [{ relPath: 'logs/app.log', artifactType: 'log', size: 1234 }],
    jiraTicketMarkdown: '# KAN-1\n\nticket body',
    jiraCommentsMarkdown: 'comment body',
    transcripts: [{ title: 'Investigation chat', text: 'user: what broke\nassistant: cache key' }],
    priorDraft: {
      rootCause: { findingId: null, statement: 'earlier hypothesis', evidence: [] },
      contributing: [],
      symptoms: [],
      ruledOut: [],
      duplicates: [],
      impact: '',
      timeline: [],
      remediation: { immediate: '', followUps: [] },
      execSummary: { whatBroke: '', impact: '', why: '', nextSteps: '' },
      techNarrative: [],
      sections: {}
    }
  }
}

function validDraft(): RcaDraft {
  return {
    rootCause: {
      findingId: 7,
      statement: 'the cache key omitted the tenant id',
      evidence: [{ path: 'logs/app.log', line: 12, evidence: 'cache hit for wrong tenant' }]
    },
    contributing: [],
    symptoms: [{ findingId: 7, statement: 'tenants saw each other’s cached data' }],
    ruledOut: [],
    duplicates: [],
    impact: 'cross-tenant data leak in cached responses',
    timeline: [{ at: '2026-01-01', what: 'bug introduced' }],
    remediation: { immediate: 'invalidate cache', followUps: ['add tenant id to cache key'] },
    execSummary: {
      whatBroke: 'cached data leaked between tenants',
      impact: 'customers saw other tenants’ data',
      why: 'the cache key omitted the tenant id',
      nextSteps: 'add tenant id to the cache key'
    },
    techNarrative: [],
    sections: {}
  }
}

describe('buildCaseRcaPrompt', () => {
  it('builds a prompt containing every section and the findings with ids', () => {
    const p = buildCaseRcaPrompt(minimalInput(), DEFAULT_RCA_TEMPLATE)
    for (const key of Object.keys(RCA_SECTIONS)) expect(p).toContain(RCA_SECTIONS[key].text)
    expect(p).toContain('[finding 7]')
  })
})

describe('parseRcaOutput', () => {
  it('parses a valid draft and rejects malformed output with raw retained', () => {
    const draft = parseRcaOutput('```json\n' + JSON.stringify(validDraft()) + '\n```')
    expect(draft.rootCause.statement).toBe('the cache key omitted the tenant id')
    expect(() => parseRcaOutput('no fence at all')).toThrowError(RcaParseError)
    try {
      parseRcaOutput('```json\n{"rootCause": 5}\n```')
      expect.unreachable('should have thrown')
    } catch (e) {
      expect((e as RcaParseError).raw).toContain('rootCause')
    }
  })
})

describe('caseRcaPromptHash', () => {
  it('prompt hash is stable and override-sensitive', () => {
    expect(caseRcaPromptHash(undefined, DEFAULT_RCA_TEMPLATE)).toBe(
      caseRcaPromptHash(undefined, DEFAULT_RCA_TEMPLATE)
    )
    expect(caseRcaPromptHash((id) => id + 'X', DEFAULT_RCA_TEMPLATE)).not.toBe(
      caseRcaPromptHash(undefined, DEFAULT_RCA_TEMPLATE)
    )
  })
})

describe('template-driven prompt', () => {
  it('briefs every enabled narrative section with its id, report, heading and instruction', () => {
    const p = buildCaseRcaPrompt(minimalInput(), DEFAULT_RCA_TEMPLATE)
    expect(p).toContain('exec-what-happened')
    expect(p).toContain('One short paragraph for a non-technical reader')
    expect(p).toContain('tech-impact')
    // the id list the model must return
    expect(p).toContain('"exec-what-happened"')
    expect(p).toContain('"tech-impact"')
  })

  it('labels which report each section belongs to', () => {
    const p = buildCaseRcaPrompt(minimalInput(), DEFAULT_RCA_TEMPLATE)
    const execIdx = p.indexOf('exec-what-happened')
    const techIdx = p.indexOf('tech-impact')
    expect(p.slice(0, execIdx)).toMatch(/executive summary/i)
    expect(p.slice(execIdx, techIdx)).toMatch(/technical report/i)
  })

  it('omits a disabled section entirely — the model is not asked to write it', () => {
    const t = structuredClone(DEFAULT_RCA_TEMPLATE)
    t.exec[0].enabled = false
    const p = buildCaseRcaPrompt(minimalInput(), t)
    expect(p).not.toContain('exec-what-happened')
  })

  it('never briefs a claims section', () => {
    const p = buildCaseRcaPrompt(minimalInput(), DEFAULT_RCA_TEMPLATE)
    expect(p).not.toContain('tech-root-cause')
  })

  it('includes a user-added section with its own instruction', () => {
    const t = structuredClone(DEFAULT_RCA_TEMPLATE)
    t.tech.push({
      id: 'tech-detection',
      heading: 'Detection',
      kind: 'narrative',
      enabled: true,
      instruction: 'How the fault was noticed and how long detection took.'
    })
    const p = buildCaseRcaPrompt(minimalInput(), t)
    expect(p).toContain('tech-detection')
    expect(p).toContain('How the fault was noticed')
  })
})

describe('caseRcaPromptHash covers the template', () => {
  it('changes when the template changes', () => {
    const t = structuredClone(DEFAULT_RCA_TEMPLATE)
    const before = caseRcaPromptHash(undefined, t)
    t.exec[0].instruction = 'Something else entirely.'
    expect(caseRcaPromptHash(undefined, t)).not.toBe(before)
  })

  it('is stable for the same template', () => {
    expect(caseRcaPromptHash(undefined, DEFAULT_RCA_TEMPLATE)).toBe(
      caseRcaPromptHash(undefined, structuredClone(DEFAULT_RCA_TEMPLATE))
    )
  })

  it('ignores a heading change that the model is never shown', () => {
    const t = structuredClone(DEFAULT_RCA_TEMPLATE)
    const before = caseRcaPromptHash(undefined, t)
    // t.tech[0] is the CLAIMS section `tech-root-cause` — its heading is a render-time label
    // the model never sees. A narrative heading IS briefed, so changing one must move the hash.
    t.tech[0].heading = 'Cause'
    expect(caseRcaPromptHash(undefined, t)).toBe(before)
  })
})
