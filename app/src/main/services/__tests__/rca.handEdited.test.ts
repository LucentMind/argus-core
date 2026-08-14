import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase, setCaseJira, setCaseTriage } from '../caseService'
import { artifactsDir } from '../paths'
import { reportFile } from '../rca/artifacts'
import { handEditedReports } from '../rca/handEdited'
import { RcaJobs, type RcaJobsDeps } from '../rca/jobs'
import { expectedSectionIds } from '../rca/parse'
import type { CaseRcaInput, RcaDraft, RcaDroppedSections } from '../../../shared/rca'
import { DEFAULT_RCA_TEMPLATE, type RcaTemplate } from '../../../shared/rcaTemplate'
import type { AppSettings } from '../../../shared/settings'

let home: string
let db: DatabaseSync
let template: RcaTemplate = DEFAULT_RCA_TEMPLATE

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rca-handedited-'))
  db = openDb(path.join(home, 'argus.db'))
  template = DEFAULT_RCA_TEMPLATE
})

afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

function validDraft(): RcaDraft {
  return {
    rootCause: {
      findingId: null,
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

/** `validDraft()` carrying a body for every narrative section `t` briefs — what a well-behaved
 *  model returns. `runJob` validates raw output against the JOB's template, so a fake `run`
 *  whose job must reach `done` has to go through here. Mirrors `rca.jobs.test.ts`. */
function wellFormedDraftFor(t: RcaTemplate): RcaDraft {
  return {
    ...validDraft(),
    sections: Object.fromEntries(
      expectedSectionIds(t).map((id) => [id, { body: `body of ${id}`, citations: [] }])
    )
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

function mkJobs(): RcaJobs {
  const deps: RcaJobsDeps = {
    db,
    argusHome: home,
    assembleInput: (slug, prior) => ({
      ...MINIMAL_INPUT,
      caseMeta: { ...MINIMAL_INPUT.caseMeta, slug },
      priorDraft: prior
    }),
    run: async () => '```json\n' + JSON.stringify(wellFormedDraftFor(template)) + '\n```',
    broadcast: () => {},
    settings: () => ({ rca: { template } }) as unknown as AppSettings
  }
  return new RcaJobs(deps)
}

/** Generates, waits for `done`, and confirms — leaving a real confirmed job with real
 *  artifacts and a real `rca-structure.json` on disk, exactly as the brief requires. */
async function confirmCase(
  slug: string,
  dropped?: RcaDroppedSections,
  edited: RcaDraft = wellFormedDraftFor(template)
): Promise<void> {
  createCase(db, home, { slug, title: slug })
  const jobs = mkJobs()
  const job = jobs.generate(slug)
  await jobs.idle()
  jobs.confirm(slug, job.id, [], edited, dropped)
}

describe('handEditedReports', () => {
  it('reports neither report edited right after confirm', async () => {
    await confirmCase('case-a')
    expect(handEditedReports({ db, argusHome: home }, 'case-a')).toEqual({
      exec: false,
      tech: false
    })
  })

  // A draft confirmed before the template drove the prompt has an empty `sections` map, so its
  // narrative sections render through the legacy-field fallback. The re-render has to take the
  // same path, or every such report would read as hand-edited the moment this shipped.
  it('reports neither report edited for a legacy draft with no model-authored sections', async () => {
    await confirmCase('case-legacy', undefined, validDraft())
    expect(handEditedReports({ db, argusHome: home }, 'case-legacy')).toEqual({
      exec: false,
      tech: false
    })
  })

  it('detects an edit to one report and leaves the other alone', async () => {
    await confirmCase('case-a')
    fs.writeFileSync(reportFile(home, 'case-a', 'exec'), '# hand written')
    expect(handEditedReports({ db, argusHome: home }, 'case-a')).toEqual({
      exec: true,
      tech: false
    })
  })

  it('detects a whitespace-only edit — bytes are the comparison, not meaning', async () => {
    await confirmCase('case-a')
    const f = reportFile(home, 'case-a', 'tech')
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + '\n')
    expect(handEditedReports({ db, argusHome: home }, 'case-a').tech).toBe(true)
  })

  it('reproduces the confirmed bytes when sections were dropped at confirm', async () => {
    await confirmCase('case-b', { exec: ['exec-impact'] })
    expect(handEditedReports({ db, argusHome: home }, 'case-b')).toEqual({
      exec: false,
      tech: false
    })
  })

  it('reports neither edited when the case has no confirmed report', () => {
    createCase(db, home, { slug: 'case-never', title: 'case-never' })
    expect(handEditedReports({ db, argusHome: home }, 'case-never')).toEqual({
      exec: false,
      tech: false
    })
  })

  it('reports neither edited when the structure file is missing, rather than throwing', async () => {
    await confirmCase('case-a')
    fs.rmSync(path.join(artifactsDir(home, 'case-a'), 'rca-structure.json'))
    expect(() => handEditedReports({ db, argusHome: home }, 'case-a')).not.toThrow()
    expect(handEditedReports({ db, argusHome: home }, 'case-a')).toEqual({
      exec: false,
      tech: false
    })
  })

  it('reports neither edited when the structure file is valid JSON but not a valid RcaDraft, rather than throwing', async () => {
    await confirmCase('case-a')
    fs.writeFileSync(path.join(artifactsDir(home, 'case-a'), 'rca-structure.json'), '{}')
    expect(() => handEditedReports({ db, argusHome: home }, 'case-a')).not.toThrow()
    expect(handEditedReports({ db, argusHome: home }, 'case-a')).toEqual({
      exec: false,
      tech: false
    })
  })

  it('reports neither edited when reading a report artifact fails with a non-ENOENT error, rather than throwing', async () => {
    // readReportMarkdown only swallows ENOENT; EISDIR (routine here — the exec report path
    // now names a directory instead of a file) must also degrade to "not edited", never escape.
    await confirmCase('case-a')
    fs.rmSync(reportFile(home, 'case-a', 'exec'))
    fs.mkdirSync(reportFile(home, 'case-a', 'exec'))
    // Confirm the fixture actually produces a non-ENOENT error before relying on it.
    expect(() => fs.readFileSync(reportFile(home, 'case-a', 'exec'), 'utf8')).toThrow(/EISDIR/)
    expect(() => handEditedReports({ db, argusHome: home }, 'case-a')).not.toThrow()
    expect(handEditedReports({ db, argusHome: home }, 'case-a')).toEqual({
      exec: false,
      tech: false
    })
  })

  // Regression: caseMeta must be snapshotted at confirm and replayed from that snapshot, not
  // rebuilt from the live case row. Both rendered reports embed meta (title/jiraKey/slug), and
  // both are mutable after confirm — most commonly linking Jira, which is required before the
  // report can be posted at all. Re-rendering under LIVE meta after that link makes an untouched
  // report falsely read as hand-edited.
  it('reports neither edited after the case gains a Jira link post-confirm', async () => {
    await confirmCase('case-a')
    setCaseJira(db, home, 'case-a', {
      key: 'ARGUS-123',
      site: 'example.atlassian.net',
      lastSyncedAt: '2026-01-02'
    })
    expect(handEditedReports({ db, argusHome: home }, 'case-a')).toEqual({
      exec: false,
      tech: false
    })
  })

  it('reports neither edited after the case title changes post-confirm', async () => {
    await confirmCase('case-a')
    setCaseTriage(db, home, 'case-a', { title: 'A renamed title' })
    expect(handEditedReports({ db, argusHome: home }, 'case-a')).toEqual({
      exec: false,
      tech: false
    })
  })

  it('still detects a genuine hand-edit after the case meta changes post-confirm', async () => {
    await confirmCase('case-a')
    setCaseJira(db, home, 'case-a', {
      key: 'ARGUS-123',
      site: 'example.atlassian.net',
      lastSyncedAt: '2026-01-02'
    })
    fs.writeFileSync(reportFile(home, 'case-a', 'exec'), '# hand written')
    expect(handEditedReports({ db, argusHome: home }, 'case-a')).toEqual({
      exec: true,
      tech: false
    })
  })

  it("falls back to live case meta (today's behaviour) when meta_snapshot is NULL, rather than reporting a false result", async () => {
    await confirmCase('case-a')
    db.prepare(`UPDATE rca_jobs SET meta_snapshot = NULL WHERE case_slug = ?`).run('case-a')
    // Meta unchanged from confirm — the live row and the (missing) snapshot agree either way,
    // so the NULL-fallback path still reports "not edited".
    expect(handEditedReports({ db, argusHome: home }, 'case-a')).toEqual({
      exec: false,
      tech: false
    })
    // And the fallback still catches a genuine hand-edit.
    fs.writeFileSync(reportFile(home, 'case-a', 'tech'), '# hand written')
    expect(handEditedReports({ db, argusHome: home }, 'case-a').tech).toBe(true)
  })

  it('degrades a malformed meta_snapshot to the live-meta fallback rather than throwing', async () => {
    await confirmCase('case-a')
    db.prepare(`UPDATE rca_jobs SET meta_snapshot = 'not json' WHERE case_slug = ?`).run('case-a')
    expect(() => handEditedReports({ db, argusHome: home }, 'case-a')).not.toThrow()
    expect(handEditedReports({ db, argusHome: home }, 'case-a')).toEqual({
      exec: false,
      tech: false
    })
  })
})
