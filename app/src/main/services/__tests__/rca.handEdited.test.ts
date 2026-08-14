import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { artifactsDir } from '../paths'
import { reportFile } from '../rca/artifacts'
import { handEditedReports } from '../rca/handEdited'
import { RcaJobs, type RcaJobsDeps } from '../rca/jobs'
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

function mkJobs(): RcaJobs {
  const deps: RcaJobsDeps = {
    db,
    argusHome: home,
    assembleInput: (slug, prior) => ({
      ...MINIMAL_INPUT,
      caseMeta: { ...MINIMAL_INPUT.caseMeta, slug },
      priorDraft: prior
    }),
    run: async () => '```json\n' + JSON.stringify(validDraft()) + '\n```',
    broadcast: () => {},
    settings: () => ({ rca: { template } }) as unknown as AppSettings
  }
  return new RcaJobs(deps)
}

/** Generates, waits for `done`, and confirms — leaving a real confirmed job with real
 *  artifacts and a real `rca-structure.json` on disk, exactly as the brief requires. */
async function confirmCase(slug: string, dropped?: RcaDroppedSections): Promise<void> {
  createCase(db, home, { slug, title: slug })
  const jobs = mkJobs()
  const job = jobs.generate(slug)
  await jobs.idle()
  jobs.confirm(slug, job.id, [], validDraft(), dropped)
}

describe('handEditedReports', () => {
  it('reports neither report edited right after confirm', async () => {
    await confirmCase('case-a')
    expect(handEditedReports({ db, argusHome: home }, 'case-a')).toEqual({
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
})
