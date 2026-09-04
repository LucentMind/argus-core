import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, setCaseStatus } from '../../caseService'
import { listProposals } from '../../proposals'
import { sharedSkillsDir } from '../../skillsDir'
import { assembleDistillInput } from '../input'
import { stageDistillOutput } from '../staging'
import { DistillQueue } from '../queue'
import { runCaseDistillPipeline, type PipelineRunners } from '../v3/pipeline'
import type { CaseDistillInput } from '../../../../shared/distill'
import type { HeadlessAgentResult, HeadlessResult } from '../../agent/driver'

const SKILL = `---\nname: diagnose-x\ndescription: when X\n---\n# diagnose-x\n\n## Steps\n1. a\n`

/** The candidates fence: one routable skill-edit, plus a skill-new the veto must drop as
 *  `target-exists` — so `dropped_json` proves the veto actually ran inside the queued job. */
const CANDS =
  '```json\n' +
  JSON.stringify({
    candidates: [
      {
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
      },
      {
        kind: 'procedure',
        type: 'skill-new',
        target: 'diagnose-x',
        title: 'dup',
        outline: 'o',
        evidence: ['root_cause'],
        related: [],
        generalization: 'g',
        routing_rationale: 'r',
        confidence: 0.5
      }
    ]
  }) +
  '\n```'
const SUMMARY =
  '```json\n{"summary":{"signature":"s","symptoms":"y","rootCause":"r","fix":"f","keywords":["k"]}}\n```'
const MAT =
  '```json\n{"ops":[{"op":"append-section","heading":"## Steps","content":"2. b"}],"basis":"a real basis of twenty+ chars"}\n```'

/** The dossier fence, citing the REAL finding row this case's snapshot carries — a hard-coded id
 *  would make the staged proposal's `evidence:` frontmatter unfalsifiable. */
const DOSSIER_FOR = (input: CaseDistillInput): string =>
  '```json\n' +
  JSON.stringify({
    scope: { status: 'closed', resolution: 'solved', settled: true, note: '' },
    root_cause: { text: 'rc', cites: [{ finding: input.findings[0].id }] },
    confirmed_fix: null,
    rejected_hypotheses: [],
    diagnostic_path: [],
    durable_facts: [],
    user_corrections: []
  }) +
  '\n```'

const ONE_SHOT_USAGE = { inputTokens: 1, outputTokens: 1, costUsd: 0.01, durationMs: 10 }

const fakeAgent =
  (text: string): PipelineRunners['agent'] =>
  async (): Promise<HeadlessAgentResult> => ({
    text,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5, durationMs: 100 },
    turnCount: 2,
    toolCallCount: 1,
    trajectory: []
  })

/** Routes by prompt marker exactly as the pipeline's own unit tests do. */
const routeOneShot = (prompt: string): string =>
  prompt.includes('# Dossier (established') ? CANDS : prompt.includes('# Candidate') ? MAT : SUMMARY

const fakeOneShot: PipelineRunners['oneShot'] = async (prompt): Promise<HeadlessResult> => ({
  text: routeOneShot(prompt),
  usage: ONE_SHOT_USAGE
})

let home: string
let db: DatabaseSync
let findingId: number
let skillsIndex: { name: string; description: string; content: string }[]

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'DLT drift after reset' })
  const caseId = (db.prepare(`SELECT id FROM cases WHERE slug='c1'`).get() as { id: number }).id
  const r = db
    .prepare(
      `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, role, created_at)
       VALUES (?, NULL, NULL, 'Root cause found', 'accepted', 'root-cause', '2026-08-16T00:00:00Z')`
    )
    .run(caseId)
  findingId = Number(r.lastInsertRowid)
  fs.appendFileSync(
    path.join(home, 'cases', 'c1', 'findings.md'),
    `\n<!-- finding:${findingId} -->\n## Root cause found\n\nClock resync.\n`
  )
  // one installed skill on disk — the skill-edit target, read back the way index.ts builds the
  // distiller's index (the tier-winning SKILL.md verbatim)
  const skillDir = path.join(sharedSkillsDir(home), 'diagnose-x')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), SKILL)
  skillsIndex = [
    {
      name: 'diagnose-x',
      description: 'when X',
      content: fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')
    }
  ]
  setCaseStatus(db, home, 'c1', 'closed', 'solved')
})

function makeQueue(
  input: CaseDistillInput,
  oneShot: PipelineRunners['oneShot'] = fakeOneShot
): DistillQueue {
  return new DistillQueue({
    db,
    argusHome: home,
    assembleInput: () => input,
    distill: (inp, signal) =>
      runCaseDistillPipeline(
        inp,
        { agent: fakeAgent(DOSSIER_FOR(input)), oneShot },
        undefined,
        signal
      ),
    stage: (slug, jobId, output) => stageDistillOutput(db, home, slug, jobId, output),
    broadcast: () => undefined,
    listArchivedProposalsFn: () => [],
    runOneShot: async () => ({ text: '' })
  })
}

describe('v3 distillation end to end (snapshot → pipeline → staging → inbox)', () => {
  it('v3: stages a materialized skill-edit with evidence and records stages + drops', async () => {
    const input = assembleDistillInput(db, home, 'c1', skillsIndex)
    // the dossier cite below is only meaningful because this is the real row id
    expect(input.findings[0].id).toBe(findingId)

    const queue = makeQueue(input)
    queue.enqueue('c1')
    await queue.idle()

    const pending = listProposals(home).filter((p) => p.caseSlug === 'c1')
    expect(pending.map((p) => p.type).sort()).toEqual(['case-summary', 'skill-edit'])

    const row = db
      .prepare(
        `SELECT state, item_count, stages_json, dropped_json, cost_usd FROM distill_jobs WHERE kind='case'`
      )
      .get() as Record<string, unknown>
    expect(row.state).toBe('done')
    expect(row.item_count).toBe(2)
    const stages = JSON.parse(row.stages_json as string) as Record<string, unknown>
    expect(stages.materialize).toHaveLength(1)
    expect((stages.dossier as { rawOutput: string }).rawOutput).toBe(DOSSIER_FOR(input))
    // dossier 0.5 + summary 0.01 + candidates 0.01 + 1 materialize 0.01
    expect(row.cost_usd).toBeGreaterThan(0)
    // the veto's own drop reaches the job row, not just the pipeline's return value, tagged with
    // its origin so a reader can't mistake it for a staging cap/basis drop.
    expect(JSON.parse(row.dropped_json as string)).toEqual([
      {
        type: 'skill-new',
        target: 'diagnose-x',
        title: 'dup',
        reason: 'target-exists',
        stage: 'veto'
      }
    ])

    const skillEdit = pending.find((p) => p.type === 'skill-edit')!
    expect(skillEdit.target).toBe('diagnose-x')
    const raw = fs.readFileSync(path.join(home, 'proposals', skillEdit.file), 'utf8')
    // Task 13: the dossier cites ride onto the staged file as an `evidence:` frontmatter line
    expect(raw).toContain(`evidence: [{"finding":${findingId}}]`)
    expect(raw).toContain('basis: a real basis of twenty+ chars')
    // the patch op was applied against the skill actually installed on disk
    expect(raw).toContain('1. a\n2. b')
  })

  it('v3: cancel mid-materialize leaves the row cancelled and stages nothing', async () => {
    const input = assembleDistillInput(db, home, 'c1', skillsIndex)
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    let materializeStarted: () => void = () => undefined
    const started = new Promise<void>((r) => {
      materializeStarted = r
    })
    const oneShot: PipelineRunners['oneShot'] = async (prompt): Promise<HeadlessResult> => {
      if (!prompt.includes('# Candidate'))
        return { text: routeOneShot(prompt), usage: ONE_SHOT_USAGE }
      materializeStarted()
      // Resolves (never rejects) after the cancel — so only the queue's post-distill `aborted`
      // guard can stop this run's proposals from reaching the tray.
      await gate
      return { text: MAT, usage: ONE_SHOT_USAGE }
    }

    const queue = makeQueue(input, oneShot)
    const job = queue.enqueue('c1')
    await started
    expect(queue.statusFor('c1')).toMatchObject({ state: 'running' })

    queue.cancel(job.id)
    release()
    await queue.idle()

    expect(queue.statusFor('c1')).toMatchObject({ state: 'cancelled' })
    expect(listProposals(home).filter((p) => p.caseSlug === 'c1')).toEqual([])
    const row = db
      .prepare(`SELECT state, item_count, finished_at FROM distill_jobs WHERE id=?`)
      .get(job.id) as Record<string, unknown>
    expect(row.state).toBe('cancelled')
    // nothing was staged, so the run never recorded a result on the row
    expect(row.item_count).toBeNull()
    expect(row.finished_at).toBeTruthy()
  })
})
