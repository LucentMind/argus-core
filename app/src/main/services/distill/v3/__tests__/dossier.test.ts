import { describe, it, expect } from 'vitest'
import { buildDossierPrompt, parseDossier, resolveDossierPath, DOSSIER_SECTIONS } from '../dossier'
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
