import { describe, it, expect } from 'vitest'
import {
  buildCaseDistillPrompt,
  parseCaseDistillOutput,
  DistillParseError,
  CASE_DISTILL_CONTRACT
} from '../contract'
import type { CaseDistillInput } from '../../../../shared/distill'
import type { RcaDraft } from '../../../../shared/rca'

const INPUT: CaseDistillInput = {
  caseMeta: {
    slug: 'c1',
    title: 'T',
    jiraKey: 'AB-1',
    status: 'closed',
    resolution: 'solved',
    tags: [],
    createdAt: 'a',
    closedAt: 'b'
  },
  findings: [{ summary: 'F1', reviewState: 'accepted', role: null, body: 'body1' }],
  evidence: [{ relPath: 'evidence/a.log', artifactType: 'text', size: 10 }],
  sessionTitles: ['First look'],
  memoryIndex: '- [dlt-timing](dlt-timing.md) — entry',
  skillsIndex: [
    {
      name: 'analyze-dlt',
      description: 'd',
      content: '---\nname: analyze-dlt\n---\n# Analyze DLT\nEXISTING_SKILL_STEP'
    }
  ],
  referencesIndex: [
    {
      name: 'runbook',
      summary: 's',
      content: '---\ntitle: Runbook\n---\nEXISTING_REF_LINE',
      tier: 'confluence'
    }
  ],
  rcaStructure: null,
  alreadyCaptured: {
    proposals: [{ type: 'recipe', target: 'dlt-cmds', title: 'Cmds', state: 'rejected' }],
    memoryWrites: [{ topic: 'dlt-timing', indexEntry: 'entry' }]
  }
}

const SAMPLE_DRAFT: RcaDraft = {
  rootCause: { findingId: 1, statement: 'the cache key omitted the tenant id', evidence: [] },
  contributing: [],
  symptoms: [],
  ruledOut: [],
  duplicates: [],
  impact: 'cross-tenant leak',
  timeline: [],
  remediation: { immediate: 'invalidate cache', followUps: [] },
  execSummary: { whatBroke: '', impact: '', why: '', nextSteps: '' },
  techNarrative: []
}

describe('prompt builder', () => {
  it('includes contract, annotated findings, and already-captured section', () => {
    const p = buildCaseDistillPrompt(INPUT)
    expect(p).toContain(CASE_DISTILL_CONTRACT)
    expect(p).toContain('[accepted] F1')
    expect(p).toContain('Knowledge already captured')
    expect(p).toContain('dlt-cmds')
    expect(p).toContain('dlt-timing')
  })

  it('embeds the full current skill and reference bodies so edits can be merged in', () => {
    const p = buildCaseDistillPrompt(INPUT)
    // an edit must return the WHOLE file with its change merged in, so the distiller
    // needs the current body verbatim in the prompt — not just name/description.
    expect(p).toContain('EXISTING_SKILL_STEP')
    expect(p).toContain('EXISTING_REF_LINE')
  })

  it('contract requires edit content to be the complete post-edit file', () => {
    expect(CASE_DISTILL_CONTRACT.toLowerCase()).toContain('complete')
    expect(CASE_DISTILL_CONTRACT.toLowerCase()).toMatch(/never a (diff|fragment)/)
  })

  it('contract gives per-resolution guidance for how a case was closed', () => {
    const c = CASE_DISTILL_CONTRACT.toLowerCase()
    expect(c).toContain('resolution')
    // the two previously-unhandled closes must now have explicit handling
    expect(c).toContain('wont-fix')
    expect(c).toContain('forwarded')
  })

  it('contract forbids editing a confluence-tier reference', () => {
    const c = CASE_DISTILL_CONTRACT.toLowerCase()
    expect(c).toContain('confluence')
    expect(c).toMatch(/never edit|reference-edit only|only for a "team-knowledge"/)
  })

  it('surfaces each reference tier so the distiller can skip synced ones', () => {
    const p = buildCaseDistillPrompt(INPUT)
    expect(p).toContain('[tier: confluence]')
  })

  it('annotates a finding header with its role and inlines the confirmed RCA structure', () => {
    const withRoleAndStructure: CaseDistillInput = {
      ...INPUT,
      findings: [{ summary: 'F1', reviewState: 'accepted', role: 'root-cause', body: 'body1' }],
      rcaStructure: SAMPLE_DRAFT
    }
    const p = buildCaseDistillPrompt(withRoleAndStructure)
    expect(p).toContain('[accepted · root-cause] F1')
    expect(p).toContain('# Confirmed RCA structure (human-reviewed)')
    expect(p).toContain(JSON.stringify(SAMPLE_DRAFT, null, 2))
  })

  it('without a role or a confirmed RCA structure, the prompt is byte-identical to before', () => {
    const p = buildCaseDistillPrompt(INPUT)
    // No role → no ' · ' annotation anywhere in the finding header.
    expect(p).toContain('[accepted] F1')
    expect(p).not.toContain(' · ')
    // No confirmed structure → the section is omitted entirely, not rendered as "(none)".
    expect(p).not.toContain('Confirmed RCA structure')
  })

  it('renders status: closed and the closed timestamp for a closed case', () => {
    const p = buildCaseDistillPrompt(INPUT)
    expect(p).toContain('status: closed')
    expect(p).toContain('closed: b')
  })

  it('renders status: open and no closed timestamp for an open case', () => {
    const p = buildCaseDistillPrompt({
      ...INPUT,
      caseMeta: { ...INPUT.caseMeta, status: 'open', resolution: null }
    })
    expect(p).toContain('status: open')
    expect(p).not.toContain('closed: ')
  })

  it('F2: a pre-upgrade snapshot with no status field renders status: closed, not undefined', () => {
    // retry() replays the original input_snapshot verbatim, and a failed job's retry button
    // persists for the life of the case — a snapshot captured before the open-case distill
    // branch landed has no `status` key at all.
    const legacyMeta: Partial<CaseDistillInput['caseMeta']> = { ...INPUT.caseMeta }
    delete legacyMeta.status
    const legacy: CaseDistillInput = {
      ...INPUT,
      caseMeta: legacyMeta as CaseDistillInput['caseMeta']
    }
    const p = buildCaseDistillPrompt(legacy)
    expect(p).not.toContain('status: undefined')
    expect(p).toContain('status: closed')
    expect(p).toContain('closed: b')
  })

  it('contract tells the distiller how to treat a case that is still open', () => {
    expect(CASE_DISTILL_CONTRACT).toContain('open:')
    expect(CASE_DISTILL_CONTRACT).not.toContain('a CLOSED root-cause-analysis case')
  })

  it('F3: the open: bullet leaves a compliant path for a summary with a confirmed root cause but no fix', () => {
    // Rule 11 declares "fix" required inside "summary", and the parser hard-rejects a summary
    // with a missing/empty fix — so for "confirmed root cause, no fix yet" the open: bullet
    // must prescribe wording (like wont-fix already does), not leave "omit the summary" as the
    // model's only compliant move.
    const openBullet = CASE_DISTILL_CONTRACT.split('\n').find((l) =>
      l.trim().startsWith('- open:')
    )!
    expect(openBullet.toLowerCase()).toMatch(/fix.*must state.*no fix (is )?confirmed/)
  })

  it("F3: rule 8 no longer contradicts the open: bullet's own return {} instruction", () => {
    const rule8 = CASE_DISTILL_CONTRACT.split('\n').find((l) => /^8\./.test(l.trim()))!
    expect(rule8.toLowerCase()).toContain('open')
  })
})

describe('parseCaseDistillOutput', () => {
  const fence = (s: string): string => 'preamble\n```json\n' + s + '\n```\n'

  it('parses a full valid document', () => {
    const out = parseCaseDistillOutput(
      fence(
        JSON.stringify({
          summary: { signature: 's', symptoms: 'sy', rootCause: 'rc', fix: 'f', keywords: ['k'] },
          memoryAppends: [{ topic: 'dlt-timing', content: 'c' }],
          proposals: [{ type: 'skill-edit', target: 'analyze-dlt', title: 't', content: 'c' }]
        })
      )
    )
    expect(out.summary?.signature).toBe('s')
    expect(out.memoryAppends).toHaveLength(1)
  })

  it('accepts an empty object (nothing to distill)', () => {
    expect(parseCaseDistillOutput(fence('{}'))).toEqual({})
  })

  it.each([
    ['no fence', 'just text'],
    ['two fences', fence('{}') + fence('{}')],
    ['bad json', fence('{nope')],
    ['unknown key', fence('{"surprise": 1}')],
    [
      'bad proposal type',
      fence('{"proposals":[{"type":"memory-append","target":"t","title":"t","content":"c"}]}')
    ],
    ['summary missing field', fence('{"summary":{"signature":"s"}}')],
    ['empty topic', fence('{"memoryAppends":[{"topic":"","content":"c"}]}')],
    ['null memoryAppends entry', fence('{"memoryAppends":[null]}')],
    ['null proposal entry', fence('{"proposals":[null]}')]
  ])('rejects %s with DistillParseError carrying raw', (_name, text) => {
    expect(() => parseCaseDistillOutput(text)).toThrow(DistillParseError)
    try {
      parseCaseDistillOutput(text)
    } catch (e) {
      expect((e as DistillParseError).raw).toBe(text)
    }
  })
})
