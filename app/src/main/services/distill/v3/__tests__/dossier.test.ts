import { describe, it, expect } from 'vitest'
import {
  buildDossierPrompt,
  parseDossier,
  pruneUnknownCites,
  resolveDossierPath,
  DOSSIER_SECTIONS
} from '../dossier'
import { DistillParseError } from '../../contract'
import type { CaseDistillInput } from '../../../../../shared/distill'

const INPUT: CaseDistillInput = {
  caseMeta: {
    slug: 'c1',
    title: 'Freeze',
    jiraKey: 'AB-1',
    status: 'closed',
    resolution: 'solved',
    tags: ['nav'],
    createdAt: 'a',
    closedAt: 'b'
  },
  findings: [
    { id: 7, summary: 'flag stranded', reviewState: 'accepted', role: 'root-cause', body: 'body' },
    { id: 8, summary: 'gps drift', reviewState: 'rejected', role: 'ruled-out', body: '' }
  ],
  evidence: [{ relPath: 'logs/a.txt', artifactType: 'text', size: 10 }],
  sessionTitles: ['s1'],
  skillsIndex: [{ name: 'diagnose-x', description: 'd', content: 'FULL SKILL BODY' }],
  referencesIndex: [{ name: 'r1', summary: 's', content: 'FULL REF BODY', tier: null }],
  rcaStructure: null,
  alreadyCaptured: {
    proposals: [{ type: 'skill-edit', target: 'diagnose-x', title: 't', state: 'accepted' }]
  },
  userMessages: [{ sessionTitle: 's1', messages: ['please check the flag'] }],
  rejectDigest: 'DIGEST TEXT',
  operatorGuidance: 'GUIDANCE TEXT'
}

const VALID = `\`\`\`json
{"scope":{"status":"closed","resolution":"solved","settled":true,"note":"n"},
 "root_cause":{"text":"rc","cites":[{"finding":7}]},
 "confirmed_fix":{"text":"fx","applied":true,"cites":[{"session":1,"turn":4}]},
 "rejected_hypotheses":[{"text":"gps","how_ruled_out":"log","cites":[{"finding":8}]}],
 "diagnostic_path":[{"step":"s","observation":"o","discriminated":"d","cites":[{"evidence":"logs/a.txt"}]},
                    {"step":"uncited","observation":"o","discriminated":"d","cites":[]}],
 "durable_facts":[{"fact":"f","quote":"q","scope":null,"cites":[{"finding":7}]}],
 "user_corrections":[]}
\`\`\``

describe('buildDossierPrompt', () => {
  const p = buildDossierPrompt(INPUT)
  it('renders findings with ids, states and roles', () => {
    expect(p).toContain('### [#7 · accepted · root-cause] flag stranded')
    expect(p).toContain('### [#8 · rejected · ruled-out] gps drift')
  })
  it('renders evidence, sessions and user messages', () => {
    expect(p).toContain('- logs/a.txt (text, 10 bytes)')
    expect(p).toContain('- please check the flag')
  })
  it('does NOT carry skills, references, already-captured, digest or guidance', () => {
    expect(p).not.toContain('FULL SKILL BODY')
    expect(p).not.toContain('FULL REF BODY')
    expect(p).not.toContain('diagnose-x')
    expect(p).not.toContain('DIGEST TEXT')
    expect(p).not.toContain('GUIDANCE TEXT')
  })
  it('omits the user-messages section entirely when absent', () => {
    const q = buildDossierPrompt({ ...INPUT, userMessages: undefined })
    expect(q).not.toContain(DOSSIER_SECTIONS['user-messages'].text)
  })
  it('uses the resolver for contract and section headers', () => {
    const q = buildDossierPrompt(INPUT, (id) => `<<${id}>>`)
    expect(q.startsWith('<<headless.case-distill.dossier.contract>>')).toBe(true)
    expect(q).toContain('<<headless.case-distill.dossier.section.findings>>')
  })
})

describe('parseDossier', () => {
  it('parses a valid dossier and drops uncited items with a count', () => {
    const { dossier, uncitedDropped } = parseDossier(VALID)
    expect(dossier.root_cause?.cites).toEqual([{ finding: 7 }])
    expect(dossier.diagnostic_path).toHaveLength(1)
    expect(uncitedDropped).toEqual({ diagnostic_path: 1 })
  })
  it('nulls an uncited root_cause', () => {
    const { dossier } = parseDossier(
      VALID.replace('"cites":[{"finding":7}]},\n "confirmed_fix"', '"cites":[]},\n "confirmed_fix"')
    )
    expect(dossier.root_cause).toBeNull()
  })
  it('rejects a malformed cite', () => {
    expect(() => parseDossier(VALID.replace('{"finding":7}', '{"foo":7}'))).toThrow(
      DistillParseError
    )
  })
  it('rejects zero or two fences and unknown keys', () => {
    expect(() => parseDossier('nope')).toThrow(DistillParseError)
    expect(() => parseDossier(VALID + '\n' + VALID)).toThrow(DistillParseError)
    expect(() => parseDossier(VALID.replace('"scope"', '"extra":1,"scope"'))).toThrow(
      DistillParseError
    )
  })
  it('requires scope', () => {
    expect(() => parseDossier('```json\n{"root_cause":null}\n```')).toThrow(DistillParseError)
  })
})

describe('pruneUnknownCites', () => {
  /** Session 1 with 5 snapshot messages — `read_transcript` pages these 0-based (offset 0 = the
   *  first message), so turns 0..4 exist and turn 5 does not. */
  const WITH_WORLD: CaseDistillInput = {
    ...INPUT,
    world: {
      sessions: [
        {
          id: 1,
          title: 's1',
          messages: Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `m${i}` }))
        }
      ]
    }
  }

  it('keeps every cite that names a real finding, turn or evidence path', () => {
    const { dossier } = parseDossier(VALID)
    const r = pruneUnknownCites(dossier, WITH_WORLD)
    expect(r.dropped).toEqual({})
    expect(r.dossier).toEqual(dossier)
  })

  it('drops an item whose only cite names a finding the input never had, and counts it', () => {
    const { dossier } = parseDossier(VALID.replace('{"finding":8}', '{"finding":404}'))
    const r = pruneUnknownCites(dossier, WITH_WORLD)
    expect(r.dossier.rejected_hypotheses).toEqual([])
    expect(r.dropped).toEqual({ rejected_hypotheses: 1 })
  })

  it('nulls root_cause and confirmed_fix when all of their cites are pruned', () => {
    const { dossier } = parseDossier(
      VALID.split('{"finding":7}')
        .join('{"finding":404}')
        .replace('{"session":1,"turn":4}', '{"session":9,"turn":0}')
    )
    const r = pruneUnknownCites(dossier, WITH_WORLD)
    expect(r.dossier.root_cause).toBeNull()
    expect(r.dossier.confirmed_fix).toBeNull()
    // durable_facts[0] cited the same invented finding
    expect(r.dropped).toEqual({ root_cause: 1, confirmed_fix: 1, durable_facts: 1 })
  })

  it('rejects a turn past the end of the snapshot session, and any session with no world at all', () => {
    const past = parseDossier(VALID.replace('"turn":4', '"turn":5')).dossier
    expect(pruneUnknownCites(past, WITH_WORLD).dossier.confirmed_fix).toBeNull()
    const ok = parseDossier(VALID).dossier
    expect(pruneUnknownCites(ok, { ...INPUT, world: undefined }).dossier.confirmed_fix).toBeNull()
  })

  it('rejects an evidence relPath that is not in the inventory', () => {
    const { dossier } = parseDossier(VALID.replace('logs/a.txt', 'logs/invented.txt'))
    const r = pruneUnknownCites(dossier, WITH_WORLD)
    expect(r.dossier.diagnostic_path).toEqual([])
    expect(r.dropped).toEqual({ diagnostic_path: 1 })
  })

  it('prunes every finding cite when the snapshot carries no finding ids (pre-v3 input)', () => {
    const noIds: CaseDistillInput = {
      ...WITH_WORLD,
      findings: INPUT.findings.map((f) => ({
        summary: f.summary,
        reviewState: f.reviewState,
        role: f.role,
        body: f.body
      }))
    }
    const { dossier } = parseDossier(VALID)
    const r = pruneUnknownCites(dossier, noIds)
    expect(r.dossier.root_cause).toBeNull()
    expect(r.dossier.durable_facts).toEqual([])
    expect(r.dossier.rejected_hypotheses).toEqual([])
    // the session and evidence cites are still verifiable and survive
    expect(r.dossier.confirmed_fix?.cites).toEqual([{ session: 1, turn: 4 }])
    expect(r.dossier.diagnostic_path).toHaveLength(1)
  })

  it('keeps an item that has one good cite alongside a bad one, minus the bad cite', () => {
    const { dossier } = parseDossier(
      VALID.replace(
        '"cites":[{"finding":7}]},\n "confirmed_fix"',
        '"cites":[{"finding":7},{"finding":404}]},\n "confirmed_fix"'
      )
    )
    const r = pruneUnknownCites(dossier, WITH_WORLD)
    expect(r.dossier.root_cause?.cites).toEqual([{ finding: 7 }])
    expect(r.dropped).toEqual({})
  })
})

describe('resolveDossierPath', () => {
  const { dossier } = parseDossier(VALID)
  it('resolves scalar and indexed paths', () => {
    expect(resolveDossierPath(dossier, 'root_cause')?.cites).toEqual([{ finding: 7 }])
    expect(resolveDossierPath(dossier, 'durable_facts[0]')?.cites).toEqual([{ finding: 7 }])
  })
  it('returns null for unknown or out-of-range paths', () => {
    expect(resolveDossierPath(dossier, 'durable_facts[9]')).toBeNull()
    expect(resolveDossierPath(dossier, 'scope')).toBeNull()
    expect(resolveDossierPath(dossier, 'nope[0]')).toBeNull()
  })
})
