import { describe, it, expect } from 'vitest'
import {
  buildMaterializePrompt,
  parseMaterializeOutput,
  materializeToProposal,
  findTargetContent
} from '../materialize'
import { DistillParseError } from '../../contract'
import type { Dossier, KnowledgeCandidate } from '../../../../../shared/distillV3'
import type { CaseDistillInput } from '../../../../../shared/distill'

const SKILL = `---\nname: diagnose-x\ndescription: when X\n---\n# diagnose-x\n\n## Steps\n1. a\n`
const INPUT = {
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
    { name: 'diagnose-x', description: 'when X', content: SKILL },
    { name: 'other', description: 'o', content: 'OTHER BODY' }
  ],
  referencesIndex: [{ name: 'r1', summary: 's', content: '# R1\nfact', tier: null }],
  rcaStructure: null,
  alreadyCaptured: { proposals: [] }
} as unknown as CaseDistillInput
const D: Dossier = {
  scope: { status: 'closed', resolution: 'solved', settled: true, note: '' },
  root_cause: { text: 'rc', cites: [{ finding: 7 }] },
  confirmed_fix: null,
  rejected_hypotheses: [],
  diagnostic_path: [
    { step: 's', observation: 'o', discriminated: 'd', cites: [{ session: 1, turn: 2 }] }
  ],
  durable_facts: [],
  user_corrections: []
}
const cand = (over: Partial<KnowledgeCandidate>): KnowledgeCandidate => ({
  kind: 'procedure',
  type: 'skill-edit',
  target: 'diagnose-x',
  title: 't',
  outline: 'o',
  evidence: ['root_cause', 'diagnostic_path[0]'],
  related: ['r1'],
  generalization: 'g',
  routing_rationale: 'r',
  confidence: 0.9,
  ...over
})

describe('buildMaterializePrompt', () => {
  it('for an edit: carries the target file, related files, resolved evidence — not other assets', () => {
    const p = buildMaterializePrompt(INPUT, D, cand({}))
    expect(p).toContain(SKILL)
    expect(p).toContain('# R1\nfact')
    expect(p).not.toContain('OTHER BODY')
    expect(p).toContain('"session": 1')
  })
  it('for a new skill: no target section, still related + evidence', () => {
    const p = buildMaterializePrompt(INPUT, D, cand({ type: 'skill-new', target: 'diagnose-new' }))
    expect(p).not.toContain('# Target file')
    expect(p).toContain('# R1\nfact')
  })
  it('a skill and a reference sharing a name are both rendered, by kind, not one shadowing the other', () => {
    const collisionInput = {
      ...INPUT,
      skillsIndex: [
        ...INPUT.skillsIndex,
        { name: 'shared-name', description: 'shared skill', content: 'SKILL BODY shared' }
      ],
      referencesIndex: [
        ...INPUT.referencesIndex,
        { name: 'shared-name', summary: 's', content: 'REFERENCE BODY shared', tier: null }
      ]
    } as unknown as CaseDistillInput
    const p = buildMaterializePrompt(collisionInput, D, cand({ related: ['shared-name'] }))
    expect(p).toContain('## shared-name (skill)')
    expect(p).toContain('## shared-name (reference)')
    const skillIdx = p.indexOf('## shared-name (skill)')
    const refIdx = p.indexOf('## shared-name (reference)')
    expect(p.indexOf('SKILL BODY shared', skillIdx)).toBeGreaterThan(skillIdx)
    expect(p.indexOf('REFERENCE BODY shared', refIdx)).toBeGreaterThan(refIdx)
  })
})

describe('parseMaterializeOutput', () => {
  it('skill-new needs file + basis', () => {
    expect(
      parseMaterializeOutput(
        '```json\n{"file":"---\\nname: n\\n---\\nb","basis":"twenty characters basis"}\n```',
        'skill-new'
      ).file
    ).toContain('name: n')
    expect(() =>
      parseMaterializeOutput('```json\n{"basis":"twenty characters basis"}\n```', 'skill-new')
    ).toThrow(DistillParseError)
  })
  it('edit needs ops or whole_file, plus basis', () => {
    const o = parseMaterializeOutput(
      '```json\n{"ops":[{"op":"append-section","heading":"## Steps","content":"2. b"}],"basis":"twenty characters basis"}\n```',
      'skill-edit'
    )
    expect(o.ops).toHaveLength(1)
    expect(() =>
      parseMaterializeOutput('```json\n{"basis":"twenty characters basis"}\n```', 'skill-edit')
    ).toThrow(DistillParseError)
    expect(() =>
      parseMaterializeOutput(
        '```json\n{"ops":[{"op":"zap","content":"x"}],"basis":"twenty characters basis"}\n```',
        'skill-edit'
      )
    ).toThrow(DistillParseError)
  })
  it('a description-only change (frontmatter, no ops, no whole_file) parses without throwing', () => {
    const o = parseMaterializeOutput(
      '```json\n{"frontmatter":{"description":"d2"},"basis":"twenty characters basis"}\n```',
      'skill-edit'
    )
    expect(o.ops).toEqual([])
    expect(o.frontmatter?.description).toBe('d2')
  })
})

describe('materializeToProposal', () => {
  it('applies ops to the target and emits evidence JSON', () => {
    const r = materializeToProposal(INPUT, D, cand({}), {
      ops: [{ op: 'append-section', heading: '## Steps', content: '2. b' }],
      basis: 'twenty characters basis'
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.proposal.content).toContain('1. a\n2. b')
      expect(r.proposal.type).toBe('skill-edit')
      expect(JSON.parse(r.proposal.evidence!)).toEqual([{ finding: 7 }, { session: 1, turn: 2 }])
      expect(r.original).toBe(SKILL)
      expect(r.wholeFileUsed).toBe(false)
    }
  })
  it('dedupes repeated cites across evidence paths, keeping first-seen order', () => {
    // Two dossier items citing the same finding is the normal case (a root cause and the step
    // that established it) — the proposal's evidence line should name each source once.
    const shared: Dossier = {
      ...D,
      diagnostic_path: [
        {
          step: 's',
          observation: 'o',
          discriminated: 'd',
          cites: [{ session: 1, turn: 2 }, { finding: 7 }]
        }
      ]
    }
    const r = materializeToProposal(INPUT, shared, cand({}), {
      ops: [{ op: 'append-section', heading: '## Steps', content: '2. b' }],
      basis: 'twenty characters basis'
    })
    expect(r.ok && JSON.parse(r.proposal.evidence!)).toEqual([
      { finding: 7 },
      { session: 1, turn: 2 }
    ])
  })
  it('whole_file wins over ops and is flagged', () => {
    const r = materializeToProposal(INPUT, D, cand({}), {
      whole_file: '---\nname: diagnose-x\ndescription: d\n---\nnew',
      basis: 'twenty characters basis'
    })
    expect(r.ok && r.wholeFileUsed).toBe(true)
  })
  it('a reference-edit to a NEW reference starts from an empty file', () => {
    const r = materializeToProposal(
      INPUT,
      D,
      cand({ kind: 'fact', type: 'reference-edit', target: 'brand-new' }),
      {
        ops: [{ op: 'append-file', content: '# Brand new\nfact' }],
        basis: 'twenty characters basis'
      }
    )
    expect(r.ok && r.proposal.content).toContain('# Brand new')
    expect(r.ok && r.original).toBeUndefined()
  })
  it('patch failure surfaces as error', () => {
    const r = materializeToProposal(INPUT, D, cand({}), {
      ops: [{ op: 'append-section', heading: '## Nope', content: 'x' }],
      basis: 'twenty characters basis'
    })
    expect(r.ok).toBe(false)
  })
  it('a description-only edit changes just the frontmatter line, body untouched', () => {
    const r = materializeToProposal(INPUT, D, cand({}), {
      ops: [],
      frontmatter: { description: 'd2' },
      basis: 'twenty characters basis'
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const lines = r.proposal.content.split('\n')
      expect(lines).toContain('description: d2')
      expect(r.proposal.content).toContain('# diagnose-x\n\n## Steps\n1. a\n')
    }
  })
})

describe('findTargetContent', () => {
  it('looks up skills for skill types and references for reference-edit', () => {
    expect(findTargetContent(INPUT, 'skill-edit', 'diagnose-x')).toBe(SKILL)
    expect(findTargetContent(INPUT, 'reference-edit', 'r1')).toBe('# R1\nfact')
    expect(findTargetContent(INPUT, 'reference-edit', 'none')).toBeUndefined()
  })
})
