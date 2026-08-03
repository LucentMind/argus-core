import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase, getCase } from '../caseService'
import { artifactsDir } from '../paths'
import { RcaJobs, type RcaJobsDeps } from '../rca/jobs'
import { RcaParseError } from '../rca/parse'
import type { CaseRcaInput, RcaDraft } from '../../../shared/rca'

let home: string
let db: DatabaseSync

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rca-jobs-'))
  db = openDb(path.join(home, 'argus.db'))
})

afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

function insertFinding(caseId: number, summary: string): number {
  const r = db
    .prepare(
      `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at)
       VALUES (?, NULL, NULL, ?, 'accepted', '2026-01-01')`
    )
    .run(caseId, summary)
  return Number(r.lastInsertRowid)
}

function validDraft(findingId: number | null = null): RcaDraft {
  return {
    rootCause: {
      findingId,
      statement: 'the cache key omitted the tenant id',
      evidence: [{ path: 'logs/app.log', line: 12, evidence: 'cache hit for wrong tenant' }]
    },
    contributing: [],
    symptoms: [],
    ruledOut: [],
    duplicates: [],
    impact: 'cross-tenant data leak in cached responses',
    timeline: [],
    remediation: { immediate: 'invalidate cache', followUps: ['add tenant id to cache key'] },
    execSummary: {
      whatBroke: 'cached data leaked between tenants',
      impact: 'customers saw other tenants data',
      why: 'the cache key omitted the tenant id',
      nextSteps: 'add tenant id to the cache key'
    },
    techNarrative: []
  }
}

const MINIMAL_INPUT: CaseRcaInput = {
  caseMeta: {
    slug: 'x',
    title: 'X',
    jiraKey: null,
    resolution: null,
    tags: [],
    createdAt: '2026-01-01'
  },
  findings: [],
  evidence: [],
  jiraTicketMarkdown: null,
  jiraCommentsMarkdown: null,
  transcripts: [],
  priorDraft: null
}

function mkJobs(over: Partial<RcaJobsDeps> = {}): { jobs: RcaJobs; broadcasts: unknown[] } {
  const broadcasts: unknown[] = []
  const jobs = new RcaJobs({
    db,
    argusHome: home,
    assembleInput: (slug, prior) => ({
      ...MINIMAL_INPUT,
      caseMeta: { ...MINIMAL_INPUT.caseMeta, slug },
      priorDraft: prior
    }),
    run: async () => '```json\n' + JSON.stringify(validDraft()) + '\n```',
    broadcast: (p) => broadcasts.push(p),
    ...over
  })
  return { jobs, broadcasts }
}

describe('RcaJobs', () => {
  it('generate → done stores raw output; status carries the parsed draft', async () => {
    createCase(db, home, { slug: 'case-a', title: 'Case A' })
    const { jobs } = mkJobs({
      run: async () => '```json\n' + JSON.stringify(validDraft()) + '\n```'
    })
    jobs.generate('case-a')
    await jobs.idle()
    const st = jobs.statusFor('case-a')
    expect(st.job!.state).toBe('done')
    expect(st.draft!.rootCause.statement).toBeTruthy()
  })

  it('parse failure → failed with raw retained', async () => {
    createCase(db, home, { slug: 'case-b', title: 'Case B' })
    const { jobs } = mkJobs({ run: async () => 'not json' })
    jobs.generate('case-b')
    await jobs.idle()
    const st = jobs.statusFor('case-b')
    expect(st.job!.state).toBe('failed')
    expect(st.draft).toBeNull()
    const row = db.prepare(`SELECT raw_output FROM rca_jobs WHERE id = ?`).get(st.job!.id) as {
      raw_output: string
    }
    expect(row.raw_output).toBe('not json')
  })

  it('confirm writes roles, three artifacts, and confirmed_at — in that order', async () => {
    createCase(db, home, { slug: 'case-c', title: 'Case C' })
    const caseId = getCase(db, 'case-c')!.id
    const findingId = insertFinding(caseId, 'root cause finding')

    const { jobs } = mkJobs({
      run: async () => '```json\n' + JSON.stringify(validDraft(findingId)) + '\n```'
    })
    const job = jobs.generate('case-c')
    await jobs.idle()
    expect(jobs.statusFor('case-c').job!.state).toBe('done')

    const editedDraft = validDraft(findingId)
    jobs.confirm('case-c', job.id, [{ findingId, role: 'root-cause' }], editedDraft)

    const dir = artifactsDir(home, 'case-c')
    expect(fs.existsSync(path.join(dir, 'rca-structure.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'rca-exec.md'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'rca-tech.md'))).toBe(true)
    expect(jobs.statusFor('case-c').job!.confirmedAt).toBeTruthy()

    const finding = db.prepare(`SELECT role FROM findings WHERE id = ?`).get(findingId) as {
      role: string | null
    }
    expect(finding.role).toBe('root-cause')
  })

  it('confirm throws for a job that is not done, or belongs to a different case', async () => {
    createCase(db, home, { slug: 'case-d', title: 'Case D' })
    createCase(db, home, { slug: 'case-d2', title: 'Case D2' })

    const { jobs: notDoneJobs } = mkJobs({ run: async () => 'not json' })
    const notDoneJob = notDoneJobs.generate('case-d')
    await notDoneJobs.idle() // ends up failed, not done
    expect(() => notDoneJobs.confirm('case-d', notDoneJob.id, [], validDraft())).toThrow(
      /not a done job/
    )

    const { jobs: doneJobs } = mkJobs({
      run: async () => '```json\n' + JSON.stringify(validDraft()) + '\n```'
    })
    const doneJob = doneJobs.generate('case-d')
    await doneJobs.idle()
    // done, but for case-d — confirming it under case-d2's slug must throw too.
    expect(() => doneJobs.confirm('case-d2', doneJob.id, [], validDraft())).toThrow(
      /not a done job/
    )
  })

  it('generate after a confirmed job snapshots the prior draft into the input', async () => {
    createCase(db, home, { slug: 'case-e', title: 'Case E' })
    const priorSeen: (RcaDraft | null)[] = []
    const { jobs } = mkJobs({
      assembleInput: (slug, prior) => {
        priorSeen.push(prior)
        return {
          ...MINIMAL_INPUT,
          caseMeta: { ...MINIMAL_INPUT.caseMeta, slug },
          priorDraft: prior
        }
      },
      run: async () => '```json\n' + JSON.stringify(validDraft()) + '\n```'
    })

    const job1 = jobs.generate('case-e')
    await jobs.idle()
    expect(priorSeen[0]).toBeNull()

    const edited = validDraft()
    edited.rootCause.statement = 'confirmed statement for prior snapshot'
    jobs.confirm('case-e', job1.id, [], edited)

    jobs.generate('case-e')
    await jobs.idle()
    expect(priorSeen[1]).not.toBeNull()
    expect(priorSeen[1]!.rootCause.statement).toBe('confirmed statement for prior snapshot')
  })

  it('generate() throws (naming the file) when the confirmed structure file is corrupted JSON', async () => {
    createCase(db, home, { slug: 'case-j', title: 'Case J' })
    const dir = artifactsDir(home, 'case-j')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'rca-structure.json')
    fs.writeFileSync(file, '{ not valid json')
    const { jobs } = mkJobs()
    expect(() => jobs.generate('case-j')).toThrow(file)
  })

  it('generate() throws (does not silently return null) on a non-ENOENT read error', async () => {
    createCase(db, home, { slug: 'case-k', title: 'Case K' })
    const dir = artifactsDir(home, 'case-k')
    // A directory where the file is expected: readFileSync fails with EISDIR, not ENOENT.
    fs.mkdirSync(path.join(dir, 'rca-structure.json'), { recursive: true })
    const { jobs } = mkJobs()
    expect(() => jobs.generate('case-k')).toThrow()
  })

  it('recoverOnBoot flips a stranded running job to failed', () => {
    db.prepare(
      `INSERT INTO rca_jobs (case_slug, state, input_snapshot, created_at) VALUES ('case-f','running','{}','t')`
    ).run()
    const { jobs } = mkJobs()
    expect(jobs.recoverOnBoot()).toBe(1)
    expect(jobs.statusFor('case-f').job!.state).toBe('failed')
  })

  it('enqueue never throws due to a throwing broadcast, and later jobs still run', async () => {
    createCase(db, home, { slug: 'case-g', title: 'Case G' })
    const { jobs } = mkJobs({
      broadcast: () => {
        throw new Error('renderer gone')
      },
      run: async () => '```json\n' + JSON.stringify(validDraft()) + '\n```'
    })
    expect(() => jobs.generate('case-g')).not.toThrow()
    await jobs.idle()
    expect(jobs.statusFor('case-g').job!.state).toBe('done')
  })

  it('generate throws for an unknown case slug, before reading any prior draft', () => {
    let readAttempted = false
    const { jobs } = mkJobs({
      assembleInput: (slug, prior) => {
        readAttempted = true
        return {
          ...MINIMAL_INPUT,
          caseMeta: { ...MINIMAL_INPUT.caseMeta, slug },
          priorDraft: prior
        }
      }
    })
    expect(() => jobs.generate('does-not-exist')).toThrow(/Unknown case/)
    // assembleInput is only reached after readPriorDraft — proves the existence check runs
    // first, before any file (or prior-draft snapshot) read.
    expect(readAttempted).toBe(false)
  })

  it('statusFor returns the CONFIRMED (edited) structure, not the raw model draft, once confirmed', async () => {
    createCase(db, home, { slug: 'case-i', title: 'Case I' })
    const caseId = getCase(db, 'case-i')!.id
    const findingId = insertFinding(caseId, 'root cause finding')

    const rawDraft = validDraft(findingId)
    rawDraft.rootCause.statement = 'raw model statement'
    const { jobs } = mkJobs({ run: async () => '```json\n' + JSON.stringify(rawDraft) + '\n```' })
    const job = jobs.generate('case-i')
    await jobs.idle()

    const edited = validDraft(findingId)
    edited.rootCause.statement = 'human-edited statement'
    jobs.confirm('case-i', job.id, [{ findingId, role: 'root-cause' }], edited)

    const st = jobs.statusFor('case-i')
    expect(st.draft!.rootCause.statement).toBe('human-edited statement')
  })

  it('statusFor falls back to the raw-output parse when a confirmed job has no structure file', async () => {
    createCase(db, home, { slug: 'case-i2', title: 'Case I2' })
    const rawDraft = validDraft()
    rawDraft.rootCause.statement = 'raw model statement, structure file missing'
    const { jobs } = mkJobs({ run: async () => '```json\n' + JSON.stringify(rawDraft) + '\n```' })
    const job = jobs.generate('case-i2')
    await jobs.idle()
    // Confirm the row directly (bypassing jobs.confirm's own file writes) to simulate a
    // confirmed_at flag with no rca-structure.json on disk.
    db.prepare(`UPDATE rca_jobs SET confirmed_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      job.id
    )
    const st = jobs.statusFor('case-i2')
    expect(st.draft!.rootCause.statement).toBe('raw model statement, structure file missing')
  })

  it('statusFor never throws even when the confirmed structure file is corrupted JSON', async () => {
    createCase(db, home, { slug: 'case-i3', title: 'Case I3' })
    const { jobs } = mkJobs({
      run: async () => '```json\n' + JSON.stringify(validDraft()) + '\n```'
    })
    const job = jobs.generate('case-i3')
    await jobs.idle()
    db.prepare(`UPDATE rca_jobs SET confirmed_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      job.id
    )
    const dir = artifactsDir(home, 'case-i3')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'rca-structure.json'), '{ not valid json')
    expect(() => jobs.statusFor('case-i3')).not.toThrow()
    // Corrupt structure file + intact raw_output → falls back to the raw parse rather than null.
    expect(jobs.statusFor('case-i3').draft).not.toBeNull()
  })

  it('confirm rejects a malformed edited draft before applying roles or writing artifacts', async () => {
    createCase(db, home, { slug: 'case-l', title: 'Case L' })
    const caseId = getCase(db, 'case-l')!.id
    const findingId = insertFinding(caseId, 'root cause finding')
    const { jobs } = mkJobs({
      run: async () => '```json\n' + JSON.stringify(validDraft(findingId)) + '\n```'
    })
    const job = jobs.generate('case-l')
    await jobs.idle()

    const malformed = validDraft(findingId)
    malformed.rootCause.statement = '' // draftSchema requires .min(1)
    expect(() =>
      jobs.confirm('case-l', job.id, [{ findingId, role: 'root-cause' }], malformed)
    ).toThrow()

    const dir = artifactsDir(home, 'case-l')
    expect(fs.existsSync(path.join(dir, 'rca-structure.json'))).toBe(false)
    const finding = db.prepare(`SELECT role FROM findings WHERE id = ?`).get(findingId) as {
      role: string | null
    }
    expect(finding.role).toBeNull()
  })

  it('confirm rejects an empty techNarrative heading', async () => {
    createCase(db, home, { slug: 'case-m', title: 'Case M' })
    const { jobs } = mkJobs({
      run: async () => '```json\n' + JSON.stringify(validDraft()) + '\n```'
    })
    const job = jobs.generate('case-m')
    await jobs.idle()

    const malformed = validDraft()
    malformed.techNarrative = [{ heading: '', body: 'body text', citations: [] }]
    expect(() => jobs.confirm('case-m', job.id, [], malformed)).toThrow()
  })

  it('records RcaParseError as the failure reason', async () => {
    createCase(db, home, { slug: 'case-h', title: 'Case H' })
    const { jobs } = mkJobs({
      run: async () => {
        throw new RcaParseError('bad output', 'RAW TEXT HERE')
      }
    })
    jobs.generate('case-h')
    await jobs.idle()
    const st = jobs.statusFor('case-h')
    expect(st.job!.state).toBe('failed')
    expect(st.job!.error).toContain('bad output')
    const row = db.prepare(`SELECT raw_output FROM rca_jobs WHERE id = ?`).get(st.job!.id) as {
      raw_output: string
    }
    expect(row.raw_output).toBe('RAW TEXT HERE')
  })
})
