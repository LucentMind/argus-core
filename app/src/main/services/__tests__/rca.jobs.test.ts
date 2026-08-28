import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase, getCase } from '../caseService'
import { freezeCase } from '../caseFreeze'
import { artifactsDir } from '../paths'
import { RcaJobs, type RcaJobsDeps } from '../rca/jobs'
import { expectedSectionIds, RcaParseError } from '../rca/parse'
import type { CaseRcaInput, RcaDraft, RcaDroppedSections } from '../../../shared/rca'
import { DEFAULT_RCA_TEMPLATE, type RcaTemplate } from '../../../shared/rcaTemplate'
import type { AppSettings } from '../../../shared/settings'

let home: string
let db: DatabaseSync
let template: RcaTemplate = DEFAULT_RCA_TEMPLATE

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rca-jobs-'))
  db = openDb(path.join(home, 'argus.db'))
  template = DEFAULT_RCA_TEMPLATE
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
    techNarrative: [],
    sections: {}
  }
}

/** The valid draft with NO model-authored sections — what a model that ignored the template's
 *  section briefs returns. `runJob` must fail such a job naming the keys it is missing. */
function draftWithoutSections(): RcaDraft {
  return { ...validDraft(), sections: {} }
}

/** `d` fenced as raw model output, carrying a body for every section `t` briefs — what a
 *  well-behaved model returns. `runJob` validates the raw output against the JOB's template, so
 *  every fake `run` whose job is expected to reach `done` has to go through here. */
function wellFormedRawFor(t: RcaTemplate, d: RcaDraft = validDraft()): string {
  const sections = Object.fromEntries(
    expectedSectionIds(t).map((id) => [id, { body: `body of ${id}`, citations: [] }])
  )
  return '```json\n' + JSON.stringify({ ...d, sections }) + '\n```'
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
    run: async () => ({ text: wellFormedRawFor(DEFAULT_RCA_TEMPLATE) }),
    broadcast: (p) => broadcasts.push(p),
    settings: () => ({ rca: { template } }) as unknown as AppSettings,
    ...over
  })
  return { jobs, broadcasts }
}

describe('RcaJobs', () => {
  it('generate → done stores raw output; status carries the parsed draft', async () => {
    createCase(db, home, { slug: 'case-a', title: 'Case A' })
    const { jobs } = mkJobs({
      run: async () => ({ text: wellFormedRawFor(DEFAULT_RCA_TEMPLATE) })
    })
    jobs.generate('case-a')
    await jobs.idle()
    const st = jobs.statusFor('case-a')
    expect(st.job!.state).toBe('done')
    expect(st.draft!.rootCause.statement).toBeTruthy()
  })

  it('parse failure → failed with raw retained', async () => {
    createCase(db, home, { slug: 'case-b', title: 'Case B' })
    const { jobs } = mkJobs({ run: async () => ({ text: 'not json' }) })
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
      run: async () => ({ text: wellFormedRawFor(DEFAULT_RCA_TEMPLATE, validDraft(findingId)) })
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

  it('confirm refuses a frozen case and an archived one, writing neither roles nor artifacts', async () => {
    // The same loss class the freeze exists for, one directory over: confirm drops three files
    // into artifacts/ AFTER the bundle would have been sealed. It also refuses an ARCHIVED
    // case — the RCA files survive archiving now, so a post-archive confirm would leave them
    // disagreeing with the sealed copy a restore puts back.
    for (const slug of ['case-frozen', 'case-archived']) {
      createCase(db, home, { slug, title: slug })
      const caseId = getCase(db, slug)!.id
      const findingId = insertFinding(caseId, 'root cause finding')
      const { jobs } = mkJobs({
        run: async () => ({ text: wellFormedRawFor(DEFAULT_RCA_TEMPLATE, validDraft(findingId)) })
      })
      const job = jobs.generate(slug)
      await jobs.idle()
      expect(jobs.statusFor(slug).job!.state).toBe('done')

      const freeze = slug === 'case-frozen' ? freezeCase(slug) : null
      if (!freeze) {
        db.prepare(`UPDATE cases SET archived_at = ? WHERE slug = ?`).run('2026-01-02', slug)
      }
      try {
        expect(
          () =>
            jobs.confirm(slug, job.id, [{ findingId, role: 'root-cause' }], validDraft(findingId))
          // Each branch matches ITS OWN message and not the other's: a bare /archived/i also
          // matches "is being archived right now", so the archived case would have passed
          // while actually being refused for the frozen reason.
        ).toThrow(
          slug === 'case-frozen'
            ? /is being archived right now/i
            : /is archived and cannot accept new files/i
        )
      } finally {
        freeze?.release()
      }

      // nothing was written: not the files, not the roles, not confirmed_at
      const dir = artifactsDir(home, slug)
      expect(fs.existsSync(path.join(dir, 'rca-structure.json'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'rca-exec.md'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'rca-tech.md'))).toBe(false)
      const finding = db.prepare(`SELECT role FROM findings WHERE id = ?`).get(findingId) as {
        role: string | null
      }
      expect(finding.role).toBeNull()
      expect(jobs.statusFor(slug).job!.confirmedAt).toBeNull()
    }
  })

  it('confirm throws for a job that is not done, or belongs to a different case', async () => {
    createCase(db, home, { slug: 'case-d', title: 'Case D' })
    createCase(db, home, { slug: 'case-d2', title: 'Case D2' })

    const { jobs: notDoneJobs } = mkJobs({ run: async () => ({ text: 'not json' }) })
    const notDoneJob = notDoneJobs.generate('case-d')
    await notDoneJobs.idle() // ends up failed, not done
    expect(() => notDoneJobs.confirm('case-d', notDoneJob.id, [], validDraft())).toThrow(
      /not a done job/
    )

    const { jobs: doneJobs } = mkJobs({
      run: async () => ({ text: wellFormedRawFor(DEFAULT_RCA_TEMPLATE) })
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
      run: async () => ({ text: wellFormedRawFor(DEFAULT_RCA_TEMPLATE) })
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
      run: async () => ({ text: wellFormedRawFor(DEFAULT_RCA_TEMPLATE) })
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
    const { jobs } = mkJobs({
      run: async () => ({ text: wellFormedRawFor(DEFAULT_RCA_TEMPLATE, rawDraft) })
    })
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
    const { jobs } = mkJobs({
      run: async () => ({ text: wellFormedRawFor(DEFAULT_RCA_TEMPLATE, rawDraft) })
    })
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
      run: async () => ({ text: wellFormedRawFor(DEFAULT_RCA_TEMPLATE) })
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
      run: async () => ({ text: wellFormedRawFor(DEFAULT_RCA_TEMPLATE, validDraft(findingId)) })
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
      run: async () => ({ text: wellFormedRawFor(DEFAULT_RCA_TEMPLATE) })
    })
    const job = jobs.generate('case-m')
    await jobs.idle()

    const malformed = validDraft()
    malformed.techNarrative = [{ heading: '', body: 'body text', citations: [] }]
    expect(() => jobs.confirm('case-m', job.id, [], malformed)).toThrow()
  })

  it('confirm succeeds end-to-end when the root cause is the explicit "no confirmed root cause" placeholder', async () => {
    // Regression for the fix-7 x fix-4 seam: RcaPanel's "no root cause" warning dialog is dead
    // if freezing that state always fails schema validation. The renderer now emits this exact
    // placeholder (rcaDraft.ts's NO_ROOT_CAUSE_STATEMENT) instead of an empty statement — this
    // proves the service side accepts it end to end (validate → applyReportRoles → artifacts).
    createCase(db, home, { slug: 'case-n', title: 'Case N' })
    const { jobs } = mkJobs({
      run: async () => ({ text: wellFormedRawFor(DEFAULT_RCA_TEMPLATE) })
    })
    const job = jobs.generate('case-n')
    await jobs.idle()

    const placeholderDraft = validDraft()
    placeholderDraft.rootCause = {
      findingId: null,
      statement: 'No confirmed root cause.',
      evidence: []
    }
    expect(() => jobs.confirm('case-n', job.id, [], placeholderDraft)).not.toThrow()

    const dir = artifactsDir(home, 'case-n')
    expect(fs.existsSync(path.join(dir, 'rca-structure.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'rca-exec.md'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'rca-tech.md'))).toBe(true)
    const st = jobs.statusFor('case-n')
    expect(st.job!.confirmedAt).toBeTruthy()
    expect(st.draft!.rootCause.statement).toBe('No confirmed root cause.')
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

  it('snapshots the current template onto the job at generate time', () => {
    createCase(db, home, { slug: 'case-a', title: 'Case A' })
    const { jobs } = mkJobs()
    const custom = JSON.parse(JSON.stringify(DEFAULT_RCA_TEMPLATE)) as RcaTemplate
    custom.exec[0].heading = 'Overview'
    template = custom // the `settings()` dep below reads this
    const job = jobs.generate('case-a')
    const row = db.prepare(`SELECT template_snapshot FROM rca_jobs WHERE id = ?`).get(job.id) as {
      template_snapshot: string
    }
    expect(JSON.parse(row.template_snapshot).exec[0].heading).toBe('Overview')
  })

  it('reports the snapshot on status, and the default for a row that predates the column', () => {
    createCase(db, home, { slug: 'case-a', title: 'Case A' })
    const custom = JSON.parse(JSON.stringify(DEFAULT_RCA_TEMPLATE)) as RcaTemplate
    custom.exec[0].heading = 'Overview'
    template = custom
    const { jobs } = mkJobs()
    const job = jobs.generate('case-a')
    expect(jobs.statusFor('case-a').template.exec[0].heading).toBe('Overview')
    db.prepare(`UPDATE rca_jobs SET template_snapshot = NULL WHERE id = ?`).run(job.id)
    expect(jobs.statusFor('case-a').template).toEqual(DEFAULT_RCA_TEMPLATE)
  })

  it('falls back to the default template when the snapshot column holds unparseable JSON', () => {
    createCase(db, home, { slug: 'case-a', title: 'Case A' })
    const { jobs } = mkJobs()
    const job = jobs.generate('case-a')
    db.prepare(`UPDATE rca_jobs SET template_snapshot = 'not json' WHERE id = ?`).run(job.id)
    expect(jobs.statusFor('case-a').template).toEqual(DEFAULT_RCA_TEMPLATE)
  })

  it('falls back to the default template when the snapshot column holds valid JSON that is not a template', () => {
    createCase(db, home, { slug: 'case-a', title: 'Case A' })
    const { jobs } = mkJobs()
    const job = jobs.generate('case-a')
    db.prepare(`UPDATE rca_jobs SET template_snapshot = 'null' WHERE id = ?`).run(job.id)
    expect(jobs.statusFor('case-a').template).toEqual(DEFAULT_RCA_TEMPLATE)
  })

  it('fails the job with a named-key error when the model omits a template section', async () => {
    createCase(db, home, { slug: 'case-a', title: 'Case A' })
    const { jobs } = mkJobs({
      run: async () => ({ text: '```json\n' + JSON.stringify(draftWithoutSections()) + '\n```' })
    })
    const job = jobs.generate('case-a')
    await jobs.idle()
    const row = jobs.statusFor('case-a').job!
    expect(row.state).toBe('failed')
    expect(row.error).toMatch(/missing section/)
    expect(job.id).toBe(row.id)
  })

  /** The default template plus one user-added narrative section. */
  function templateWithDetection(): RcaTemplate {
    const custom = structuredClone(DEFAULT_RCA_TEMPLATE)
    custom.tech.push({
      id: 'tech-detection',
      heading: 'Detection',
      kind: 'narrative',
      enabled: true,
      instruction: 'How the fault was noticed.'
    })
    return custom
  }

  /** A job left QUEUED under `snapshot` — the state in which live settings can genuinely drift
   *  away from what the model will be briefed on (a job queued behind another, or one that
   *  survived a restart). `runJob` reads its template synchronously before awaiting the model,
   *  so this is the only shape in which "snapshot vs live settings" is observable at all. */
  function queueJobUnder(slug: string, snapshot: RcaTemplate): void {
    createCase(db, home, { slug, title: slug })
    db.prepare(
      `INSERT INTO rca_jobs (case_slug, state, input_snapshot, template_snapshot, created_at)
       VALUES (?, 'queued', ?, ?, '2026-01-01')`
    ).run(slug, JSON.stringify(MINIMAL_INPUT), JSON.stringify(snapshot))
  }

  it('demands the sections its OWN snapshot briefed, including a user-added one', async () => {
    // Enqueued under a template carrying `tech-detection`, so the model is briefed on it and
    // must return it — even though live settings no longer mention it by the time the job runs.
    // Fails if runJob validates against live settings (or a hardcoded default) instead.
    queueJobUnder('case-a', templateWithDetection())
    template = DEFAULT_RCA_TEMPLATE
    const { jobs } = mkJobs({ run: async () => ({ text: wellFormedRawFor(DEFAULT_RCA_TEMPLATE) }) })
    jobs.recoverOnBoot()
    await jobs.idle()
    const row = jobs.statusFor('case-a').job!
    expect(row.state).toBe('failed')
    expect(row.error).toMatch(/tech-detection/)
  })

  it('does not demand a section that only live settings added after enqueue', async () => {
    // The mirror case: a template GROWN while the job sat queued must not retroactively fail a
    // run whose model was never briefed on the new id.
    queueJobUnder('case-a', DEFAULT_RCA_TEMPLATE)
    template = templateWithDetection()
    const { jobs } = mkJobs({ run: async () => ({ text: wellFormedRawFor(DEFAULT_RCA_TEMPLATE) }) })
    jobs.recoverOnBoot()
    await jobs.idle()
    expect(jobs.statusFor('case-a').job!.state).toBe('done')
  })

  it('confirms under the snapshot, not under changed live settings', async () => {
    createCase(db, home, { slug: 'case-a', title: 'Case A' })
    const { jobs } = mkJobs({
      run: async () => ({ text: wellFormedRawFor(DEFAULT_RCA_TEMPLATE) })
    })
    const custom = JSON.parse(JSON.stringify(DEFAULT_RCA_TEMPLATE)) as RcaTemplate
    custom.exec[0].heading = 'Overview'
    template = custom
    const job = jobs.generate('case-a')
    await jobs.idle()
    template = DEFAULT_RCA_TEMPLATE // user edits the template after generating
    jobs.confirm('case-a', job.id, [], validDraft())
    const exec = fs.readFileSync(path.join(artifactsDir(home, 'case-a'), 'rca-exec.md'), 'utf8')
    expect(exec).toContain('## Overview')
    expect(exec).not.toContain('## What happened')
  })
})

describe('RcaJobs.confirm with dropped sections', () => {
  async function doneJob(slug: string): Promise<{ jobs: RcaJobs; jobId: number }> {
    createCase(db, home, { slug, title: slug })
    const { jobs } = mkJobs({
      run: async () => ({ text: wellFormedRawFor(DEFAULT_RCA_TEMPLATE) })
    })
    const job = jobs.generate(slug)
    await jobs.idle()
    return { jobs, jobId: job.id }
  }

  function artifacts(slug: string): { exec: string; tech: string } {
    const dir = artifactsDir(home, slug)
    return {
      exec: fs.readFileSync(path.join(dir, 'rca-exec.md'), 'utf8'),
      tech: fs.readFileSync(path.join(dir, 'rca-tech.md'), 'utf8')
    }
  }

  it('omits a dropped exec section from rca-exec.md while the tech counterpart stays', async () => {
    const { jobs, jobId } = await doneJob('case-d1')
    jobs.confirm('case-d1', jobId, [], validDraft(), { exec: ['exec-impact'] })
    const { exec, tech } = artifacts('case-d1')
    expect(exec).not.toContain('## Impact')
    expect(exec).toContain('## What happened')
    expect(tech).toContain('## Impact')
  })

  it('omits a dropped tech section from rca-tech.md only', async () => {
    const { jobs, jobId } = await doneJob('case-d2')
    jobs.confirm('case-d2', jobId, [], validDraft(), { tech: ['tech-impact'] })
    const { exec, tech } = artifacts('case-d2')
    expect(tech).not.toContain('## Impact')
    expect(exec).toContain('## Impact')
  })

  it('persists the dropped set on the job row as JSON', async () => {
    const { jobs, jobId } = await doneJob('case-d3')
    jobs.confirm('case-d3', jobId, [], validDraft(), { exec: ['exec-impact'] })
    const row = db.prepare(`SELECT dropped_sections FROM rca_jobs WHERE id = ?`).get(jobId) as {
      dropped_sections: string | null
    }
    expect(JSON.parse(row.dropped_sections!)).toEqual({ exec: ['exec-impact'] })
    // and it is readable back on status, so a reload re-renders the confirmed bytes
    expect(jobs.statusFor('case-d3').dropped).toEqual({ exec: ['exec-impact'] })
  })

  it('persists the exact rendered caseMeta on the job row as JSON', async () => {
    const { jobs, jobId } = await doneJob('case-d3b')
    jobs.confirm('case-d3b', jobId, [], validDraft())
    const row = db.prepare(`SELECT meta_snapshot FROM rca_jobs WHERE id = ?`).get(jobId) as {
      meta_snapshot: string | null
    }
    expect(JSON.parse(row.meta_snapshot!)).toMatchObject({ slug: 'case-d3b', title: 'case-d3b' })
  })

  it('confirming without the argument produces the current bytes and leaves the column NULL', async () => {
    const { jobs, jobId } = await doneJob('case-d4')
    jobs.confirm('case-d4', jobId, [], validDraft())
    const { exec, tech } = artifacts('case-d4')
    expect(exec).toContain('## Impact')
    expect(tech).toContain('## Impact')
    const row = db.prepare(`SELECT dropped_sections FROM rca_jobs WHERE id = ?`).get(jobId) as {
      dropped_sections: string | null
    }
    expect(row.dropped_sections).toBeNull()
    expect(jobs.statusFor('case-d4').dropped).toEqual({})
  })

  it('degrades a NULL or malformed dropped_sections column to "nothing dropped"', async () => {
    const { jobs, jobId } = await doneJob('case-d5')
    db.prepare(`UPDATE rca_jobs SET dropped_sections = 'not json' WHERE id = ?`).run(jobId)
    expect(jobs.statusFor('case-d5').dropped).toEqual({})
    db.prepare(`UPDATE rca_jobs SET dropped_sections = '42' WHERE id = ?`).run(jobId)
    expect(jobs.statusFor('case-d5').dropped).toEqual({})
    db.prepare(`UPDATE rca_jobs SET dropped_sections = NULL WHERE id = ?`).run(jobId)
    expect(jobs.statusFor('case-d5').dropped).toEqual({})
  })

  it('coerces a malformed dropped payload to "nothing dropped" instead of throwing', async () => {
    const { jobs, jobId } = await doneJob('case-d6')
    jobs.confirm('case-d6', jobId, [], validDraft(), {
      exec: 'exec-impact'
    } as unknown as RcaDroppedSections)
    expect(artifacts('case-d6').exec).toContain('## Impact')
  })
})
