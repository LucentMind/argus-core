import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createFakeRunners,
  resolveFakeRunners,
  stageOf,
  slugOf,
  ONE_SHOT_DEFAULT_USAGE,
  AGENT_DEFAULT_USAGE,
  DEFAULT_DIGEST_TEXT,
  FAKE_CALLS_FILE,
  type FakeCaseStages,
  type FakeStage
} from '../fakeRunner'
import {
  buildDossierPrompt,
  DOSSIER_LITE_CONTRACT,
  DOSSIER_SECTIONS,
  DOSSIER_CONTRACT
} from '../v3/dossier'
import { buildSummaryPrompt, SUMMARY_CONTRACT } from '../v3/summary'
import { buildCandidatesPrompt, CANDIDATES_CONTRACT } from '../v3/candidates'
import { buildMaterializePrompt, MATERIALIZE_CONTRACT } from '../v3/materialize'
import {
  buildAttributionPrompt,
  ATTRIBUTION_CONTRACT,
  ATTRIBUTION_SECTIONS
} from '../v3/attribution'
import { buildCaseDistillPrompt } from '../contract'
import { CASE_DISTILL_CONTRACT } from '../caseDistillContract'
import { DIGEST_PROMPT } from '../rejectDigest'
import type { CaseDistillInput } from '../../../../shared/distill'
import type { Dossier, KnowledgeCandidate } from '../../../../shared/distillV3'

const INPUT: CaseDistillInput = {
  caseMeta: {
    slug: 'fx-a',
    title: 'T',
    jiraKey: null,
    status: 'closed',
    resolution: 'solved',
    tags: [],
    createdAt: 'a',
    closedAt: 'b'
  },
  findings: [{ id: 7, summary: 'f', reviewState: 'accepted', role: 'root-cause', body: '' }],
  evidence: [],
  sessionTitles: [],
  skillsIndex: [{ name: 'diagnose-x', description: 'when X', content: '# diagnose-x\n' }],
  referencesIndex: [],
  rcaStructure: null,
  alreadyCaptured: { proposals: [] },
  world: { sessions: [] },
  assets: [
    {
      kind: 'skill',
      name: 'diagnose-x',
      tier: 'user',
      callCount: 1,
      firstSeen: { sessionId: 1, turnId: null }
    }
  ],
  caseOutcome: 'solved'
} as unknown as CaseDistillInput

const DOSSIER = {
  scope: { status: 'closed', resolution: 'solved', settled: true, note: '' },
  root_cause: { text: 'rc', cites: [{ finding: 7 }] },
  confirmed_fix: null,
  rejected_hypotheses: [],
  diagnostic_path: [],
  durable_facts: [],
  user_corrections: []
} as unknown as Dossier
const CANDIDATE = {
  kind: 'procedure',
  type: 'skill-edit',
  target: 'diagnose-x',
  title: 't',
  outline: 'o',
  evidence: ['root_cause'],
  related: [],
  generalization: 'g',
  routing_rationale: 'r',
  confidence: 0.9
} as unknown as KnowledgeCandidate

// The lite resolver is private to attributionOnly.ts; this is its same fallback.
const liteResolve = (id: string): string => {
  if (id === 'headless.case-distill.dossier.contract') return DOSSIER_LITE_CONTRACT
  const m = /^headless\.case-distill\.(dossier|attribution)\.section\.(.+)$/.exec(id)
  const spec = m ? (m[1] === 'dossier' ? DOSSIER_SECTIONS : ATTRIBUTION_SECTIONS)[m[2]] : undefined
  if (!spec) throw new Error(`unknown prompt id ${id}`)
  return spec.text
}

const PROMPTS = {
  dossier: buildDossierPrompt(INPUT),
  dossierLite: buildDossierPrompt(INPUT, liteResolve),
  summary: buildSummaryPrompt(INPUT, DOSSIER),
  candidates: buildCandidatesPrompt(INPUT, DOSSIER),
  attribution: buildAttributionPrompt(INPUT, DOSSIER),
  materialize: buildMaterializePrompt(INPUT, DOSSIER, CANDIDATE),
  v2: buildCaseDistillPrompt(INPUT),
  rejectDigest: DIGEST_PROMPT + '\n\nrejects: 3'
} satisfies Record<FakeStage, string>

const caseOf = (stages: FakeCaseStages): { cases: Map<string, FakeCaseStages> } => ({
  cases: new Map([['fx-a', stages]])
})
const agentOpts = { mcpServer: {}, allowedTools: [], maxIterations: 5 }

const tmpDirs: string[] = []
const tmpDir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-runner-'))
  tmpDirs.push(d)
  return d
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('stageOf / slugOf', () => {
  it('recognises all eight stages from the real prompt builders, and nothing else', () => {
    for (const [stage, prompt] of Object.entries(PROMPTS))
      expect(stageOf(prompt), stage).toBe(stage)
    expect(stageOf('hello')).toBeNull()
  })

  it('the full and lite dossier prompts open with their own contract', () => {
    expect(PROMPTS.dossier.startsWith(DOSSIER_CONTRACT)).toBe(true)
    expect(PROMPTS.dossierLite.startsWith(DOSSIER_LITE_CONTRACT)).toBe(true)
    expect(PROMPTS.dossier.startsWith(DOSSIER_LITE_CONTRACT)).toBe(false)
  })

  it('a full dossier prompt that inlines the lite contract in its body is still the full dossier', () => {
    expect(stageOf(`${PROMPTS.dossier}\n\n${DOSSIER_LITE_CONTRACT}`)).toBe('dossier')
  })

  it('every contract opens with a distinct first sentence (recognition is unambiguous)', () => {
    const contracts = [
      DOSSIER_CONTRACT,
      SUMMARY_CONTRACT,
      CANDIDATES_CONTRACT,
      MATERIALIZE_CONTRACT,
      ATTRIBUTION_CONTRACT,
      CASE_DISTILL_CONTRACT,
      DIGEST_PROMPT
    ]
    const heads = contracts.map((c) => /^[\s\S]*?\.(?=\s|$)/.exec(c)?.[0] ?? '')
    expect(heads.every((h) => h.length > 0)).toBe(true)
    expect(new Set(heads).size).toBe(contracts.length)
    for (const a of heads) for (const b of heads) if (a !== b) expect(b.startsWith(a)).toBe(false)
  })

  it('slugOf reads the case slug from every prompt that carries one', () => {
    for (const [stage, prompt] of Object.entries(PROMPTS)) {
      // materialize has no # Case section; the reject digest is case-independent
      const expected = stage === 'materialize' || stage === 'rejectDigest' ? null : 'fx-a'
      expect(slugOf(prompt), stage).toBe(expected)
    }
  })
})

describe('createFakeRunners({ cases })', () => {
  it('serves one-shot and agent stages with merged default usage and spec counters', async () => {
    const r = createFakeRunners(
      caseOf({
        summary: { text: 'S', usage: { costUsd: 0.5 } },
        dossier: { text: 'D', turnCount: 4, toolCallCount: 9 }
      })
    )
    expect(await r.oneShot(PROMPTS.summary)).toEqual({
      text: 'S',
      usage: { ...ONE_SHOT_DEFAULT_USAGE, costUsd: 0.5 }
    })
    expect(await r.agent(PROMPTS.dossier, agentOpts)).toEqual({
      text: 'D',
      usage: AGENT_DEFAULT_USAGE,
      turnCount: 4,
      toolCallCount: 9,
      trajectory: []
    })
  })

  it('materialize resolves from the sticky slug of the previous prompt; first, it has no slug', async () => {
    const stages = { materialize: { text: 'M' }, summary: { text: 'S' } }
    const cold = createFakeRunners(caseOf(stages))
    await expect(cold.oneShot(PROMPTS.materialize)).rejects.toThrow(/no slug/)
    const warm = createFakeRunners(caseOf(stages))
    await warm.oneShot(PROMPTS.summary)
    expect((await warm.oneShot(PROMPTS.materialize)).text).toBe('M')
  })

  it('throws the spec message; reports capHit with an empty text; returns non-fenced text verbatim', async () => {
    const r = createFakeRunners(
      caseOf({
        summary: { throw: 'boom' },
        dossier: { capHit: 'iterations', capSubtype: 'error_max_turns' },
        candidates: { text: 'not a fence at all' }
      })
    )
    await expect(r.oneShot(PROMPTS.summary)).rejects.toThrow('boom')
    expect(await r.agent(PROMPTS.dossier, agentOpts)).toEqual({
      text: '',
      usage: AGENT_DEFAULT_USAGE,
      turnCount: 1,
      toolCallCount: 0,
      trajectory: [],
      capHit: 'iterations',
      capSubtype: 'error_max_turns'
    })
    expect((await r.oneShot(PROMPTS.candidates)).text).toBe('not a fence at all')
    // capSubtype is present only when the spec gave one
    const bare = createFakeRunners(caseOf({ dossier: { capHit: 'timeout' } }))
    const hit = await bare.agent(PROMPTS.dossier, agentOpts)
    expect(hit.capHit).toBe('timeout')
    expect('capSubtype' in hit).toBe(false)
  })

  it('rejects unrecognised prompts and missing fixtures; a missing rejectDigest yields the default', async () => {
    const r = createFakeRunners(caseOf({ summary: { text: 'S' } }))
    await expect(r.oneShot('hello there')).rejects.toThrow(
      /unrecognised prompt \(starts "hello there"\)/
    )
    const other = buildSummaryPrompt(
      { ...INPUT, caseMeta: { ...INPUT.caseMeta, slug: 'fx-b' } },
      DOSSIER
    )
    await expect(r.oneShot(other)).rejects.toThrow(/no fixture for fx-b\/summary/)
    const digest = await r.oneShot(PROMPTS.rejectDigest)
    expect(digest.text).toBe(DEFAULT_DIGEST_TEXT)
    expect(digest.usage).toEqual(ONE_SHOT_DEFAULT_USAGE)
  })

  it('names a missing stage on a known case', async () => {
    const r = createFakeRunners(caseOf({ summary: { text: 'S' } }))
    await expect(r.oneShot(PROMPTS.candidates)).rejects.toThrow(/no fixture for fx-a\/candidates/)
  })

  it('dossierLite falls back to the dossier entry, and prefers its own when present', async () => {
    const fallback = createFakeRunners(caseOf({ dossier: { text: 'FULL' } }))
    expect((await fallback.agent(PROMPTS.dossierLite, agentOpts)).text).toBe('FULL')
    const own = createFakeRunners(
      caseOf({ dossier: { text: 'FULL' }, dossierLite: { text: 'LITE' } })
    )
    expect((await own.agent(PROMPTS.dossierLite, agentOpts)).text).toBe('LITE')
    expect((await own.agent(PROMPTS.dossier, agentOpts)).text).toBe('FULL')
  })

  it('rejects with an AbortError when the signal is already aborted', async () => {
    const r = createFakeRunners(caseOf({ summary: { text: 'S' }, dossier: { text: 'D' } }))
    const signal = AbortSignal.abort()
    await expect(r.oneShot(PROMPTS.summary, { signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    await expect(r.agent(PROMPTS.dossier, { ...agentOpts, signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  it('rejects a stage sent to the wrong runner', async () => {
    const r = createFakeRunners(caseOf({ summary: { text: 'S' }, dossier: { text: 'D' } }))
    await expect(r.agent(PROMPTS.summary, agentOpts)).rejects.toThrow(/one-shot stage/)
    await expect(r.oneShot(PROMPTS.dossier)).rejects.toThrow(/agent stage/)
  })

  it('hands each call to opts.log as a JSON line', async () => {
    const lines: string[] = []
    const r = createFakeRunners(caseOf({ summary: { text: 'S' } }), { log: (l) => lines.push(l) })
    await r.oneShot(PROMPTS.summary)
    await r.oneShot(PROMPTS.rejectDigest)
    const parsed = lines.map((l) => JSON.parse(l))
    expect(parsed.map((p) => [p.stage, p.slug, p.mode])).toEqual([
      ['summary', 'fx-a', 'text'],
      ['rejectDigest', null, 'default-digest']
    ])
    expect(typeof parsed[0].at).toBe('string')
  })

  it('the reject digest never borrows the sticky slug and ignores a case rejectDigest entry', async () => {
    const lines: string[] = []
    const r = createFakeRunners(
      caseOf({ summary: { text: 'S' }, rejectDigest: { text: '- case-specific digest' } }),
      { log: (l) => lines.push(l) }
    )
    await r.oneShot(PROMPTS.summary) // sticky slug is now fx-a
    expect((await r.oneShot(PROMPTS.rejectDigest)).text).toBe(DEFAULT_DIGEST_TEXT)
    expect(JSON.parse(lines[1])).toMatchObject({
      stage: 'rejectDigest',
      slug: null,
      mode: 'default-digest'
    })
  })
})

describe('createFakeRunners({ dir })', () => {
  it('re-reads the fixture on every call and appends one calls.ndjson line per call', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'fx-a.json')
    fs.writeFileSync(file, JSON.stringify({ summary: { text: 'first' } }))
    const r = createFakeRunners({ dir })
    expect((await r.oneShot(PROMPTS.summary)).text).toBe('first')
    fs.writeFileSync(file, JSON.stringify({ summary: { text: 'second' } }))
    expect((await r.oneShot(PROMPTS.summary)).text).toBe('second')
    const lines = fs
      .readFileSync(path.join(dir, FAKE_CALLS_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => [l.stage, l.slug, l.mode])).toEqual([
      ['summary', 'fx-a', 'text'],
      ['summary', 'fx-a', 'text']
    ])
  })

  it('reports a missing fixture file as no fixture for the slug and stage', async () => {
    const r = createFakeRunners({ dir: tmpDir() })
    await expect(r.oneShot(PROMPTS.summary)).rejects.toThrow(/no fixture for fx-a\/summary/)
  })
})

describe('resolveFakeRunners', () => {
  const run = (
    env: NodeJS.ProcessEnv,
    devTools: boolean
  ): { out: ReturnType<typeof resolveFakeRunners>; warns: string[]; infos: string[] } => {
    const warns: string[] = []
    const infos: string[] = []
    const out = resolveFakeRunners({
      env,
      devTools,
      warn: (m) => warns.push(m),
      info: (m) => infos.push(m)
    })
    return { out, warns, infos }
  }

  it('is silent and null when the variable is unset or empty', () => {
    for (const env of [{}, { ARGUS_HEADLESS_FAKE: '' }]) {
      const { out, warns, infos } = run(env, true)
      expect(out).toBeNull()
      expect(warns).toEqual([])
      expect(infos).toEqual([])
    }
  })

  it('warns and returns null without dev tools', () => {
    const { out, warns } = run({ ARGUS_HEADLESS_FAKE: tmpDir() }, false)
    expect(out).toBeNull()
    expect(warns).toEqual(['[distill] ARGUS_HEADLESS_FAKE ignored: dev tools are not enabled'])
  })

  it('warns and returns null when the directory does not exist (or is a file)', () => {
    const missing = path.join(tmpDir(), 'nope')
    const a = run({ ARGUS_HEADLESS_FAKE: missing }, true)
    expect(a.out).toBeNull()
    expect(a.warns).toEqual([
      `[distill] ARGUS_HEADLESS_FAKE ignored: directory does not exist: ${missing}`
    ])
    const file = path.join(tmpDir(), 'f.json')
    fs.writeFileSync(file, '{}')
    expect(run({ ARGUS_HEADLESS_FAKE: file }, true).out).toBeNull()
  })

  it('returns working runners and announces itself when enabled', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'fx-a.json'), JSON.stringify({ summary: { text: 'S' } }))
    const { out, warns, infos } = run({ ARGUS_HEADLESS_FAKE: dir }, true)
    expect(warns).toEqual([])
    expect(infos).toEqual([`[distill] FAKE RUNNER active: ${dir}`])
    expect((await out!.oneShot(PROMPTS.summary)).text).toBe('S')
  })
})
