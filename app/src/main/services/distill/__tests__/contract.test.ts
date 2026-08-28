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
    proposals: [{ type: 'recipe', target: 'dlt-cmds', title: 'Cmds', state: 'rejected' }]
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
  techNarrative: [],
  sections: {}
}

describe('prompt builder', () => {
  it('includes contract, annotated findings, and already-captured section', () => {
    const p = buildCaseDistillPrompt(INPUT)
    expect(p).toContain(CASE_DISTILL_CONTRACT)
    expect(p).toContain('[accepted] F1')
    expect(p).toContain('Knowledge already captured')
    expect(p).toContain('dlt-cmds')
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
    // No role → no ' · ' annotation in the finding header itself (the contract's rule 2 now
    // legitimately mentions ' · ' in its retraction-tag example, so the check is scoped to the
    // findings section rather than the whole prompt).
    expect(p).toContain('[accepted] F1')
    const findingsSection = p.slice(p.indexOf('# Findings'), p.indexOf('# Evidence inventory'))
    expect(findingsSection).not.toContain(' · ')
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
    // The output rule declares "fix" required inside "summary", and the parser hard-rejects one
    // with a missing/empty fix — so for "confirmed root cause, no fix yet" the open: bullet
    // must prescribe wording (like wont-fix already does), not leave "omit the summary" as the
    // model's only compliant move.
    const openBullet = CASE_DISTILL_CONTRACT.split('\n').find((l) =>
      l.trim().startsWith('- open:')
    )!
    expect(openBullet.toLowerCase()).toMatch(/fix.*must state.*no fix (is )?confirmed/)
  })

  // These three locate their rule by its own text rather than by number. They used to index
  // rules 8 and 11 directly, which made them break on any insertion above — the numbering is
  // already guarded by the "rule structure" suite below, so pinning it twice bought nothing.
  const ruleContaining = (needle: string): string =>
    CASE_DISTILL_CONTRACT.split('\n').find((l) => l.includes(needle))!

  it("F3: the empty-result rule no longer contradicts the open: bullet's own return {} instruction", () => {
    expect(ruleContaining('AN EMPTY RESULT IS A VALID RESULT').toLowerCase()).toContain('open')
  })

  it('contract v2 carries the preference-order, never-capture, basis, caps, and tools rules', () => {
    const c = CASE_DISTILL_CONTRACT.toLowerCase()
    expect(c).toContain('prefer the skill-edit')
    expect(c).toContain('never capture')
    expect(c).toContain('basis')
    expect(c).toContain('final assistant message')
    expect(c).toContain('class-level')
    expect(c).toMatch(/caps:.*at most n proposals/)
  })

  it('the output rule requires a basis on every proposal', () => {
    expect(ruleContaining('OUTPUT: exactly one fenced')).toContain('content, basis')
  })

  it('renders user messages after the sessions section, grouped by session title', () => {
    const p = buildCaseDistillPrompt({
      ...INPUT,
      userMessages: [
        { sessionTitle: 'First look', messages: ['it broke again', 'try the other tenant'] }
      ]
    })
    expect(p).toContain('# User messages')
    expect(p).toContain('## First look')
    expect(p).toContain('- it broke again')
    expect(p).toContain('- try the other tenant')
    const sessionsIdx = p.indexOf('# Chat sessions')
    const userMsgIdx = p.indexOf('# User messages')
    expect(userMsgIdx).toBeGreaterThan(sessionsIdx)
  })

  it('renders the reject digest and operator guidance sections after captured, when present', () => {
    const p = buildCaseDistillPrompt({
      ...INPUT,
      rejectDigest: 'do not propose retry-with-backoff again',
      operatorGuidance: 'focus on the auth flow'
    })
    expect(p).toContain('# Observed proposal failure patterns')
    expect(p).toContain('do not propose retry-with-backoff again')
    expect(p).toContain('# Operator guidance')
    expect(p).toContain('focus on the auth flow')
    const capturedIdx = p.indexOf('Knowledge already captured')
    const digestIdx = p.indexOf('# Observed proposal failure patterns')
    const guidanceIdx = p.indexOf('# Operator guidance')
    expect(digestIdx).toBeGreaterThan(capturedIdx)
    expect(guidanceIdx).toBeGreaterThan(digestIdx)
  })

  it('renders a note annotation on a skill/reference entry line when present', () => {
    const p = buildCaseDistillPrompt({
      ...INPUT,
      skillsIndex: [{ ...INPUT.skillsIndex[0], note: 'stale — superseded by X' }],
      referencesIndex: [{ ...INPUT.referencesIndex[0], note: 'partially applies' }]
    })
    expect(p).toContain('note: stale — superseded by X')
    expect(p).toContain('note: partially applies')
  })

  it('legacy input (no userMessages/rejectDigest/operatorGuidance/note) renders byte-identical to pre-v2', () => {
    const p = buildCaseDistillPrompt(INPUT)
    expect(p).not.toContain('# User messages')
    expect(p).not.toContain('# Observed proposal failure patterns')
    expect(p).not.toContain('# Operator guidance')
    expect(p).not.toContain('note: ')
  })
})

describe('parseCaseDistillOutput', () => {
  const fence = (s: string): string => 'preamble\n```json\n' + s + '\n```\n'

  it('parses a full valid document', () => {
    const out = parseCaseDistillOutput(
      fence(
        JSON.stringify({
          summary: { signature: 's', symptoms: 'sy', rootCause: 'rc', fix: 'f', keywords: ['k'] },
          proposals: [{ type: 'skill-edit', target: 'analyze-dlt', title: 't', content: 'c' }]
        })
      )
    )
    expect(out.summary?.signature).toBe('s')
    expect(out.proposals).toHaveLength(1)
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
    [
      'memoryAppends is no longer an output key',
      fence('{"memoryAppends":[{"topic":"t","content":"c"}]}')
    ],
    ['null proposal entry', fence('{"proposals":[null]}')]
  ])('rejects %s with DistillParseError carrying raw', (_name, text) => {
    expect(() => parseCaseDistillOutput(text)).toThrow(DistillParseError)
    try {
      parseCaseDistillOutput(text)
    } catch (e) {
      expect((e as DistillParseError).raw).toBe(text)
    }
  })

  it('rejects the retired recipe type', () => {
    // The type is gone from PROPOSAL_OUT_TYPES, so a model still emitting it (an override, or a
    // replayed pre-retirement eval world) fails the parse rather than staging an unroutable
    // proposal. Archived recipes are unaffected — listArchivedProposals does not validate.
    expect(() =>
      parseCaseDistillOutput(
        fence(
          '{"proposals":[{"type":"recipe","target":"dlt-cmds","title":"Cmds","content":"body"}]}'
        )
      )
    ).toThrow(DistillParseError)
  })

  it('accepts an output with only summary and proposals', () => {
    const out = parseCaseDistillOutput(
      fence(
        '{"proposals":[{"type":"reference-edit","target":"dlt-cmds","title":"Cmds","content":"body"}]}'
      )
    )
    expect(out.proposals).toHaveLength(1)
    expect('memoryAppends' in out).toBe(false)
  })

  it('accepts and passes through an optional string basis', () => {
    const out = parseCaseDistillOutput(
      fence(
        JSON.stringify({
          proposals: [
            {
              type: 'skill-edit',
              target: 'analyze-dlt',
              title: 't',
              content: 'c',
              basis: 'transcript at msg 12: user confirmed the fix worked'
            }
          ]
        })
      )
    )
    expect(out.proposals?.[0].basis).toBe('transcript at msg 12: user confirmed the fix worked')
  })

  it('accepts a proposal with no basis (basis stays undefined)', () => {
    const out = parseCaseDistillOutput(
      fence(
        '{"proposals":[{"type":"reference-edit","target":"dlt-cmds","title":"Cmds","content":"body"}]}'
      )
    )
    expect(out.proposals?.[0].basis).toBeUndefined()
  })

  it('rejects a non-string basis with DistillParseError', () => {
    const text = fence(
      '{"proposals":[{"type":"reference-edit","target":"dlt-cmds","title":"Cmds","content":"body","basis":42}]}'
    )
    expect(() => parseCaseDistillOutput(text)).toThrow(DistillParseError)
  })
})

/**
 * Structural guards on the rule list itself. The contract is a hand-numbered prose block with
 * internal "see rule N" cross-references, so inserting or removing a rule silently desynchronises
 * every reference below it — a class of defect no consumer of the string can detect. These assert
 * the numbering, not the wording, so ordinary rule edits do not churn them.
 */
describe('CASE_DISTILL_CONTRACT rule structure', () => {
  const ruleNumbers = (): number[] =>
    [...CASE_DISTILL_CONTRACT.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]))

  it('numbers its rules 1..N with no gaps or duplicates', () => {
    const nums = ruleNumbers()
    expect(nums.length).toBeGreaterThan(0)
    expect(nums).toEqual(Array.from({ length: nums.length }, (_, i) => i + 1))
  })

  it('has no dangling rule cross-reference', () => {
    const max = Math.max(...ruleNumbers())
    const refs = [...CASE_DISTILL_CONTRACT.matchAll(/rule (\d+)/g)].map((m) => Number(m[1]))
    expect(refs.length).toBeGreaterThan(0)
    for (const r of refs) expect(r).toBeLessThanOrEqual(max)
  })

  it('no longer offers the retired recipe type', () => {
    expect(CASE_DISTILL_CONTRACT).not.toContain('recipe')
  })

  it('still requires basis in the output shape', () => {
    expect(CASE_DISTILL_CONTRACT).toMatch(/"proposals".*basis/)
  })

  it('routes by retrieval mode before applying the preference order', () => {
    const routing = CASE_DISTILL_CONTRACT.indexOf('CHOOSE THE TYPE BY HOW THE KNOWLEDGE')
    const preference = CASE_DISTILL_CONTRACT.indexOf('WHEN TWO TYPES BOTH FIT')
    expect(routing).toBeGreaterThan(-1)
    expect(preference).toBeGreaterThan(routing)
  })
})
