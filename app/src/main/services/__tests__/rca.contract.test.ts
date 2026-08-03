import { describe, it, expect } from 'vitest'
import type { CaseRcaInput, RcaDraft } from '../../../shared/rca'
import { buildCaseRcaPrompt, RCA_SECTIONS } from '../rca/contract'
import { parseRcaOutput, RcaParseError } from '../rca/parse'
import { caseRcaPromptHash } from '../rca/promptHash'

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
      techNarrative: []
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
    techNarrative: []
  }
}

describe('buildCaseRcaPrompt', () => {
  it('builds a prompt containing every section and the findings with ids', () => {
    const p = buildCaseRcaPrompt(minimalInput())
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
    expect(caseRcaPromptHash()).toBe(caseRcaPromptHash())
    expect(caseRcaPromptHash((id) => id + 'X')).not.toBe(caseRcaPromptHash())
  })
})
