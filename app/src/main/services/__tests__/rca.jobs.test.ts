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
    const { jobs } = mkJobs({ run: async () => 'not json' })
    const job = jobs.generate('case-d')
    await jobs.idle() // ends up failed, not done
    expect(() => jobs.confirm('case-d', job.id, [], validDraft())).toThrow(/not a done job/)
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
