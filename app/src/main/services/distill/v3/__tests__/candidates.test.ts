import { describe, it, expect } from 'vitest'
import { buildCandidatesPrompt, parseCandidates, CANDIDATES_SECTIONS } from '../candidates'
import { DistillParseError } from '../../contract'
import type { Dossier } from '../../../../../shared/distillV3'
import type { CaseDistillInput } from '../../../../../shared/distill'

const D: Dossier = {
  scope: { status: 'closed', resolution: 'solved', settled: true, note: '' },
  root_cause: { text: 'rc', cites: [{ finding: 7 }] },
  confirmed_fix: null,
  rejected_hypotheses: [],
  diagnostic_path: [],
  durable_facts: [],
  user_corrections: []
}
const INPUT: CaseDistillInput = {
  caseMeta: {
    slug: 'c1',
    title: 'T',
    jiraKey: null,
    status: 'closed',
    resolution: 'solved',
    tags: [],
    createdAt: 'a',
    closedAt: 'b'
  },
  findings: [],
  evidence: [],
  sessionTitles: [],
  skillsIndex: [
    {
      name: 'diagnose-x',
      description: 'when X freezes',
      content: 'FULL SKILL BODY',
      note: 'a proposed edit here was rejected as overfit (case z)'
    }
  ],
  referencesIndex: [{ name: 'r1', summary: 'sum', content: 'FULL REF BODY', tier: 'confluence' }],
  rcaStructure: null,
  alreadyCaptured: {
    proposals: [{ type: 'skill-edit', target: 'diagnose-x', title: 't', state: 'accepted' }]
  },
  rejectDigest: 'DIGEST TEXT',
  operatorGuidance: 'GUIDANCE TEXT'
}
const C = `\`\`\`json
{"candidates":[{"kind":"procedure","type":"skill-new","target":"diagnose-stranded-flag","title":"t","outline":"o",
 "evidence":["root_cause"],"related":["diagnose-x"],"generalization":"g","routing_rationale":"r","confidence":0.8}]}
\`\`\``

describe('buildCandidatesPrompt', () => {
  const p = buildCandidatesPrompt(INPUT, D)
  it('renders index NAMES + descriptions/summaries/tiers only, never bodies', () => {
    expect(p).toContain('- diagnose-x — when X freezes')
    expect(p).toContain('note: a proposed edit here was rejected as overfit (case z)')
    expect(p).toContain('- r1 [tier: confluence] — sum')
    expect(p).not.toContain('FULL SKILL BODY')
    expect(p).not.toContain('FULL REF BODY')
  })
  it('renders already-captured, digest, guidance and the dossier', () => {
    expect(p).toContain('- proposal [accepted] skill-edit → diagnose-x — t')
    expect(p).toContain('DIGEST TEXT')
    expect(p).toContain('GUIDANCE TEXT')
    expect(p).toContain('"rc"')
  })
  it('omits digest/guidance sections when absent', () => {
    const q = buildCandidatesPrompt(
      { ...INPUT, rejectDigest: undefined, operatorGuidance: undefined },
      D
    )
    expect(q).not.toContain(CANDIDATES_SECTIONS['reject-digest'].text)
    expect(q).not.toContain(CANDIDATES_SECTIONS.guidance.text)
  })
})

describe('parseCandidates', () => {
  it('parses candidates', () => {
    const { candidates } = parseCandidates(C)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].type).toBe('skill-new')
    expect(candidates[0].confidence).toBe(0.8)
  })
  it('accepts an empty candidates array', () => {
    expect(parseCandidates('```json\n{"candidates":[]}\n```')).toEqual({
      candidates: [],
      malformedDropped: 0
    })
  })
  it('defaults optional arrays and clamps confidence', () => {
    const { candidates } = parseCandidates(
      C.replace(',"related":["diagnose-x"]', '').replace('0.8', '7')
    )
    expect(candidates[0].related).toEqual([])
    expect(candidates[0].confidence).toBe(1)
  })
  it('drops a candidate with a bad kind/type or missing evidence array, rather than failing the batch', () => {
    const badKind = parseCandidates(C.replace('"procedure"', '"thing"'))
    expect(badKind.candidates).toEqual([])
    expect(badKind.malformedDropped).toBe(1)
    const badEvidence = parseCandidates(C.replace('"evidence":["root_cause"],', ''))
    expect(badEvidence.candidates).toEqual([])
    expect(badEvidence.malformedDropped).toBe(1)
  })
  it('still throws on a structurally broken payload (bad JSON, wrong fence count, non-array candidates)', () => {
    expect(() => parseCandidates('not json at all')).toThrow(DistillParseError)
    expect(() => parseCandidates('```json\n{"candidates": "nope"}\n```')).toThrow(DistillParseError)
  })
  it('drops a malformed candidate (non-string outline) but keeps the rest of the batch', () => {
    const twoOneBad = `\`\`\`json
{"candidates":[
  {"kind":"procedure","type":"skill-new","target":"diagnose-bad","title":"bad","outline":{"trigger":"t","actions":["a"],"stop_condition":"s"},"evidence":["root_cause"],"related":[],"generalization":"g","routing_rationale":"r","confidence":0.9},
  {"kind":"fact","type":"reference-edit","target":"r1","title":"good","outline":"o","evidence":["root_cause"],"related":[],"generalization":"g","routing_rationale":"r","confidence":0.6}
]}
\`\`\``
    const { candidates, malformedDropped } = parseCandidates(twoOneBad)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].target).toBe('r1')
    expect(malformedDropped).toBe(1)
  })
})
