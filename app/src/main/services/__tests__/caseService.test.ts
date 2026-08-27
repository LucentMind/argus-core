import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import {
  createCase,
  listCases,
  getCase,
  findCaseByJiraKey,
  ensureCaseOrigin,
  setCaseJira,
  setCaseJiraDeselected,
  setCaseStatus,
  setCaseSyncState,
  setReviewBaseline,
  setCaseTriage,
  setCaseReviewState,
  mergeTags,
  listCaseJiraLinks,
  addCaseJiraLink,
  removeCaseJiraLink,
  setCaseJiraLinkAttachmentIds,
  setCaseJiraLinkDeselected
} from '../caseService'
import { ingestContent } from '../ingest'
import { createDetection } from '../packs/detection'
import { caseDir } from '../paths'
import type { DatabaseSync } from 'node:sqlite'
import { createImmediateQueue } from '../ingestQueue'

let home: string
let db: DatabaseSync

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
})

describe('createCase', () => {
  it('inserts a row and scaffolds the case dir', () => {
    const rec = createCase(db, home, {
      slug: 'NAVAPI-12345',
      title: 'Tile 403s',
      jiraKey: 'NAVAPI-12345'
    })
    expect(rec.slug).toBe('NAVAPI-12345')
    expect(rec.status).toBe('open')
    expect(rec.jiraSyncedAt).toBeNull() // never refreshed yet
    const dir = path.join(home, 'cases', 'NAVAPI-12345')
    for (const p of [
      'evidence',
      'evidence/.meta',
      'sessions',
      '.rca',
      'case.json',
      'CLAUDE.md',
      'findings.md'
    ]) {
      expect(fs.existsSync(path.join(dir, p)), p).toBe(true)
    }
    const caseJson = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8'))
    expect(caseJson.slug).toBe('NAVAPI-12345')
    expect(caseJson.status).toBe('open')
  })

  // Finding 7: `phase` and `actionItems` are DERIVED (see shared/casePhase.ts and
  // shared/triage.ts) — never stored. Mirroring `{ ...rec, id: undefined }` straight onto
  // disk carries them onto case.json anyway, which is exactly the stored-vs-derived leak
  // this design set out to prevent (a value read back off disk on the next boot would go
  // stale the moment real signals change).
  it('does not write derived fields (phase, actionItems) onto case.json', () => {
    createCase(db, home, { slug: 'DERIVED-1', title: 'd' })
    const caseJson = JSON.parse(
      fs.readFileSync(path.join(home, 'cases', 'DERIVED-1', 'case.json'), 'utf8')
    )
    expect(caseJson).not.toHaveProperty('phase')
    expect(caseJson).not.toHaveProperty('actionItems')
  })

  it('rejects invalid slugs', () => {
    expect(() => createCase(db, home, { slug: '../evil', title: 'x' })).toThrow(/slug/i)
    expect(() => createCase(db, home, { slug: 'has space', title: 'x' })).toThrow(/slug/i)
  })

  it('rejects duplicate slugs', () => {
    createCase(db, home, { slug: 'CASE-1', title: 'a' })
    expect(() => createCase(db, home, { slug: 'CASE-1', title: 'b' })).toThrow()
  })

  it('scaffolds .claude symlinks and the working-rules CLAUDE.md', () => {
    // ensure shared dirs exist first
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true })
    fs.mkdirSync(path.join(home, 'references'), { recursive: true })
    createCase(db, home, { slug: 'SCAF-1', title: 'scaffold' })
    const dir = path.join(home, 'cases', 'SCAF-1')
    expect(fs.lstatSync(path.join(dir, '.claude', 'skills')).isSymbolicLink()).toBe(true)
    const claudeMd = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')
    expect(claudeMd).toContain('mcp__argus__append_finding')
    expect(claudeMd).toContain('<!-- argus:workspaces -->')
  })

  it('rolls back the DB row when scaffolding fails', () => {
    // a FILE at cases/ makes mkdirSync throw ENOTDIR/EEXIST for any case dir
    fs.writeFileSync(path.join(home, 'cases'), 'not a directory')
    expect(() => createCase(db, home, { slug: 'ROLLBACK-1', title: 'x' })).toThrow()
    expect(getCase(db, 'ROLLBACK-1')).toBeNull()
  })
})

describe('listCases / getCase', () => {
  it('lists newest first and fetches by slug', () => {
    createCase(db, home, { slug: 'A-1', title: 'first' })
    createCase(db, home, { slug: 'B-2', title: 'second' })
    const all = listCases(db)
    expect(all.map((c) => c.slug)).toEqual(['B-2', 'A-1'])
    expect(getCase(db, 'A-1')?.title).toBe('first')
    expect(getCase(db, 'missing')).toBeNull()
  })

  it('getCase normalises an unrecognised stored active_mode to the default (direct DB edit / version downgrade)', () => {
    // Same defence-in-depth convention as sessionStore.ts's sessionMode: a stored value
    // that isn't a real MODES key must not survive into activeMode, or MODES[mode] is
    // undefined and throws on every later render (no ErrorBoundary in this renderer).
    createCase(db, home, { slug: 'GARBAGE-1', title: 'g' })
    db.prepare(`UPDATE cases SET active_mode = 'some-future-mode' WHERE slug = 'GARBAGE-1'`).run()
    expect(getCase(db, 'GARBAGE-1')?.activeMode).toBe('investigation')
  })
})

describe('findCaseByJiraKey', () => {
  it('finds a case by its Jira key, so a routine adopts rather than duplicating', () => {
    createCase(db, home, { slug: 'my-own-name', title: 'ABC-1', jiraKey: 'ABC-1' })
    expect(findCaseByJiraKey(db, 'ABC-1')!.slug).toBe('my-own-name')
    expect(findCaseByJiraKey(db, 'ABC-2')).toBeNull()
  })
})

describe('setCaseJira', () => {
  it('updates jira_key and merges the jira block into case.json', () => {
    createCase(db, home, { slug: 'NAV-9', title: 't' })
    const rec = setCaseJira(db, home, 'NAV-9', {
      key: 'NAV-9',
      site: 'https://acme.atlassian.net',
      lastSyncedAt: '2026-07-10T10:00:00Z'
    })
    expect(rec.jiraKey).toBe('NAV-9')
    expect(rec.jiraSyncedAt).toBe('2026-07-10T10:00:00Z') // persisted on the case row
    expect(getCase(db, 'NAV-9')!.jiraSyncedAt).toBe('2026-07-10T10:00:00Z')
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'cases/NAV-9/case.json'), 'utf8'))
    expect(onDisk.jira).toEqual({
      key: 'NAV-9',
      site: 'https://acme.atlassian.net',
      lastSyncedAt: '2026-07-10T10:00:00Z'
    })
    expect(onDisk.title).toBe('t') // existing keys preserved
  })

  it('rebuilds from the DB record when case.json is corrupt, instead of dropping fields', () => {
    createCase(db, home, { slug: 'NAV-10', title: 'Route flicker' })
    const file = path.join(home, 'cases/NAV-10/case.json')
    fs.writeFileSync(file, '{ not valid json')

    const rec = setCaseJira(db, home, 'NAV-10', {
      key: 'NAV-10',
      site: 'https://acme.atlassian.net',
      lastSyncedAt: '2026-07-10T10:00:00Z'
    })
    expect(rec.jiraKey).toBe('NAV-10')

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(onDisk.title).toBe('Route flicker') // survived the corrupt-file fallback
    expect(onDisk.status).toBe('open')
    expect(onDisk.jira).toEqual({
      key: 'NAV-10',
      site: 'https://acme.atlassian.net',
      lastSyncedAt: '2026-07-10T10:00:00Z'
    })
  })

  // Finding 7, same leak, for setCaseJira.
  it('setCaseJira does not carry derived fields onto disk via the corrupt-file fallback', () => {
    createCase(db, home, { slug: 'NAV-11', title: 'T' })
    const file = path.join(caseDir(home, 'NAV-11'), 'case.json')
    fs.writeFileSync(file, '{ not valid json')
    setCaseJira(db, home, 'NAV-11', {
      key: 'NAV-11',
      site: 'https://acme.atlassian.net',
      lastSyncedAt: '2026-07-10T10:00:00Z'
    })
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(onDisk).not.toHaveProperty('phase')
    expect(onDisk).not.toHaveProperty('actionItems')
  })
})

describe('setCaseStatus', () => {
  it('closes a case with a resolution and mirrors to case.json', () => {
    createCase(db, home, { slug: 'c1', title: 'C1' })
    const rec = setCaseStatus(db, home, 'c1', 'closed', 'duplicate')
    expect(rec.status).toBe('closed')
    expect(rec.resolution).toBe('duplicate')
    const onDisk = JSON.parse(fs.readFileSync(path.join(caseDir(home, 'c1'), 'case.json'), 'utf8'))
    expect(onDisk.status).toBe('closed')
    expect(onDisk.resolution).toBe('duplicate')
  })

  it('throws when closing without a resolution', () => {
    createCase(db, home, { slug: 'c2', title: 'C2' })
    expect(() => setCaseStatus(db, home, 'c2', 'closed', null)).toThrow(/resolution/i)
  })

  it('clears resolution when moving to a non-closed status', () => {
    createCase(db, home, { slug: 'c3', title: 'C3' })
    setCaseStatus(db, home, 'c3', 'closed', 'solved')
    const rec = setCaseStatus(db, home, 'c3', 'open', null)
    expect(rec.status).toBe('open')
    expect(rec.resolution).toBeNull()
    const onDisk = JSON.parse(fs.readFileSync(path.join(caseDir(home, 'c3'), 'case.json'), 'utf8'))
    expect(onDisk.resolution).toBeNull()
  })

  it('clears a non-null resolution on non-closed status', () => {
    createCase(db, home, { slug: 'c4', title: 'C4' })
    setCaseStatus(db, home, 'c4', 'closed', 'solved')
    const rec = setCaseStatus(db, home, 'c4', 'open', 'duplicate')
    expect(rec.status).toBe('open')
    expect(rec.resolution).toBeNull()
    const onDisk = JSON.parse(fs.readFileSync(path.join(caseDir(home, 'c4'), 'case.json'), 'utf8'))
    expect(onDisk.resolution).toBeNull()
  })

  // Finding 7: the corrupt-file fallback rebuilds `onDisk` from `existing` (a CaseRecord),
  // which always carries the DERIVED `phase` and `actionItems` — spreading it straight onto
  // disk re-introduces the same stored-vs-derived leak createCase had.
  it('does not carry the derived phase/actionItems onto disk via the corrupt-file fallback', () => {
    createCase(db, home, { slug: 'c5', title: 'C5' })
    const file = path.join(caseDir(home, 'c5'), 'case.json')
    fs.writeFileSync(file, '{ not valid json')
    setCaseStatus(db, home, 'c5', 'closed', 'solved')
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(onDisk).not.toHaveProperty('phase')
    expect(onDisk).not.toHaveProperty('actionItems')
  })
})

describe('setCaseJiraDeselected', () => {
  it('persists ids on the record and mirrors them into case.json', () => {
    createCase(db, home, { slug: 'NAV-1', title: 'T' })
    const rec = setCaseJiraDeselected(db, home, 'NAV-1', ['10001', '10002'])
    expect(rec.jiraDeselected).toEqual(['10001', '10002'])
    expect(getCase(db, 'NAV-1')!.jiraDeselected).toEqual(['10001', '10002'])
    const cj = JSON.parse(fs.readFileSync(path.join(caseDir(home, 'NAV-1'), 'case.json'), 'utf8'))
    expect(cj.jira.deselectedAttachmentIds).toEqual(['10001', '10002'])
  })

  it('defaults to [] for cases that never set it (migration default)', () => {
    createCase(db, home, { slug: 'NAV-2', title: 'T' })
    expect(getCase(db, 'NAV-2')!.jiraDeselected).toEqual([])
  })

  it('throws on unknown case', () => {
    expect(() => setCaseJiraDeselected(db, home, 'nope', [])).toThrow(/Unknown case/)
  })

  it('setCaseJira preserves deselectedAttachmentIds in case.json', () => {
    createCase(db, home, { slug: 'NAV-3', title: 'T' })
    setCaseJiraDeselected(db, home, 'NAV-3', ['1'])
    setCaseJira(db, home, 'NAV-3', {
      key: 'NAV-3',
      site: 'https://acme.atlassian.net',
      lastSyncedAt: '2026-07-17T00:00:00Z'
    })
    const cj = JSON.parse(fs.readFileSync(path.join(caseDir(home, 'NAV-3'), 'case.json'), 'utf8'))
    expect(cj.jira.deselectedAttachmentIds).toEqual(['1'])
    expect(cj.jira.key).toBe('NAV-3')
  })

  // Finding 7, same leak, for setCaseJiraDeselected.
  it('setCaseJiraDeselected does not carry derived fields onto disk via the corrupt-file fallback', () => {
    createCase(db, home, { slug: 'NAV-4', title: 'T' })
    const file = path.join(caseDir(home, 'NAV-4'), 'case.json')
    fs.writeFileSync(file, '{ not valid json')
    setCaseJiraDeselected(db, home, 'NAV-4', ['10001'])
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(onDisk).not.toHaveProperty('phase')
    expect(onDisk).not.toHaveProperty('actionItems')
  })
})

describe('sync state persistence', () => {
  it('defaults the new fields on a fresh case', () => {
    const rec = createCase(db, home, { slug: 'C-1', title: 'T' })
    expect(rec.jiraStatus).toBeNull()
    expect(rec.jiraPriority).toBeNull()
    expect(rec.jiraCommentCount).toBeNull()
    expect(rec.jiraAttachmentIds).toEqual([])
    expect(rec.reviewBaseline).toBeNull()
    expect(rec.lastSyncError).toBeNull()
  })

  it('round-trips sync state through the DB', () => {
    createCase(db, home, { slug: 'C-1', title: 'T' })
    setCaseSyncState(db, home, 'C-1', {
      jiraStatus: 'In Progress',
      jiraPriority: 'High',
      jiraCommentCount: 4,
      jiraAttachmentIds: ['a1', 'a2'],
      lastSyncError: null
    })
    const rec = getCase(db, 'C-1')!
    expect(rec.jiraStatus).toBe('In Progress')
    expect(rec.jiraPriority).toBe('High')
    expect(rec.jiraCommentCount).toBe(4)
    expect(rec.jiraAttachmentIds).toEqual(['a1', 'a2'])
  })

  it('round-trips a sync error and clears it', () => {
    createCase(db, home, { slug: 'C-1', title: 'T' })
    setCaseSyncState(db, home, 'C-1', {
      lastSyncError: { code: 'auth', message: 'nope', at: '2026-07-20T11:00:00.000Z' }
    })
    expect(getCase(db, 'C-1')!.lastSyncError?.code).toBe('auth')
    setCaseSyncState(db, home, 'C-1', { lastSyncError: null })
    expect(getCase(db, 'C-1')!.lastSyncError).toBeNull()
  })

  it('a partial update (lastSyncError only) preserves the last-known-good jira fields', () => {
    createCase(db, home, { slug: 'C-1', title: 'T' })
    setCaseSyncState(db, home, 'C-1', {
      jiraStatus: 'In Progress',
      jiraPriority: 'High',
      jiraCommentCount: 4,
      jiraAttachmentIds: ['a1', 'a2'],
      lastSyncError: null
    })

    setCaseSyncState(db, home, 'C-1', {
      lastSyncError: { code: 'auth', message: 'nope', at: '2026-07-20T11:00:00.000Z' }
    })
    let rec = getCase(db, 'C-1')!
    expect(rec.jiraStatus).toBe('In Progress')
    expect(rec.jiraPriority).toBe('High')
    expect(rec.jiraCommentCount).toBe(4)
    expect(rec.jiraAttachmentIds).toEqual(['a1', 'a2'])
    expect(rec.lastSyncError?.code).toBe('auth')

    setCaseSyncState(db, home, 'C-1', { lastSyncError: null })
    rec = getCase(db, 'C-1')!
    expect(rec.lastSyncError).toBeNull()
    expect(rec.jiraStatus).toBe('In Progress')
    expect(rec.jiraPriority).toBe('High')
    expect(rec.jiraCommentCount).toBe(4)
    expect(rec.jiraAttachmentIds).toEqual(['a1', 'a2'])
  })

  it('round-trips the review baseline and mirrors it into case.json', () => {
    createCase(db, home, { slug: 'C-1', title: 'T' })
    const baseline = {
      status: 'Open',
      commentCount: 2,
      attachmentIds: ['a1'],
      capturedAt: '2026-07-20T10:00:00.000Z'
    }
    setReviewBaseline(db, home, 'C-1', baseline)
    expect(getCase(db, 'C-1')!.reviewBaseline).toEqual(baseline)
    const onDisk = JSON.parse(fs.readFileSync(path.join(caseDir(home, 'C-1'), 'case.json'), 'utf8'))
    expect(onDisk.reviewBaseline).toEqual(baseline)
  })

  // Finding 7, same leak as setCaseStatus's corrupt-file fallback, for setCaseSyncState.
  it('setCaseSyncState does not carry derived fields onto disk via the corrupt-file fallback', () => {
    createCase(db, home, { slug: 'C-1', title: 'T' })
    const file = path.join(caseDir(home, 'C-1'), 'case.json')
    fs.writeFileSync(file, '{ not valid json')
    setCaseSyncState(db, home, 'C-1', { jiraStatus: 'In Progress' })
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(onDisk).not.toHaveProperty('phase')
    expect(onDisk).not.toHaveProperty('actionItems')
  })

  // Finding 7, same leak, for setReviewBaseline.
  it('setReviewBaseline does not carry derived fields onto disk via the corrupt-file fallback', () => {
    createCase(db, home, { slug: 'C-1', title: 'T' })
    const file = path.join(caseDir(home, 'C-1'), 'case.json')
    fs.writeFileSync(file, '{ not valid json')
    setReviewBaseline(db, home, 'C-1', {
      status: 'Open',
      commentCount: 0,
      attachmentIds: [],
      capturedAt: '2026-07-20T10:00:00.000Z'
    })
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(onDisk).not.toHaveProperty('phase')
    expect(onDisk).not.toHaveProperty('actionItems')
  })
})

describe('listCases triage ordering', () => {
  it('puts cases with action items first, then info, then untouched', () => {
    // Created in the reverse of the expected triage order, so creation-descending
    // (the old ordering) would yield ['quiet', 'stale-one', 'changed'] — wrong —
    // and only the new triage-rank sort produces the expected order below.
    for (const slug of ['changed', 'stale-one', 'quiet']) {
      createCase(db, home, { slug, title: slug })
    }
    setCaseSyncState(db, home, 'changed', { jiraStatus: 'In Progress', jiraCommentCount: 0 })
    setReviewBaseline(db, home, 'changed', {
      status: 'Open',
      commentCount: 0,
      attachmentIds: [],
      capturedAt: '2026-07-01T00:00:00.000Z'
    })
    db.prepare(
      `UPDATE cases SET jira_key = 'P-1', jira_synced_at = ? WHERE slug = 'stale-one'`
    ).run(new Date(Date.now() - 20 * 86_400_000).toISOString())
    expect(listCases(db).map((c) => c.slug)).toEqual(['changed', 'stale-one', 'quiet'])
  })

  it('breaks ties on updatedAt descending', () => {
    // 'newer' is created FIRST (so creation-descending would rank it last) — the
    // explicit updated_at values below are what must win under the new sort.
    createCase(db, home, { slug: 'newer', title: 'n' })
    createCase(db, home, { slug: 'older', title: 'o' })
    db.prepare(
      `UPDATE cases SET updated_at = '2026-01-01T00:00:00.000Z' WHERE slug = 'older'`
    ).run()
    db.prepare(
      `UPDATE cases SET updated_at = '2026-07-01T00:00:00.000Z' WHERE slug = 'newer'`
    ).run()
    expect(listCases(db).map((c) => c.slug)).toEqual(['newer', 'older'])
  })

  it('falls back to jira priority when rank and updatedAt tie', () => {
    // 'highp' is created FIRST (so creation-descending would rank it last) —
    // only the priority tiebreak below should put it first.
    createCase(db, home, { slug: 'highp', title: 'h' })
    createCase(db, home, { slug: 'lowp', title: 'l' })
    db.prepare(`UPDATE cases SET updated_at = '2026-07-01T00:00:00.000Z'`).run()
    setCaseSyncState(db, home, 'lowp', { jiraPriority: 'Low' })
    setCaseSyncState(db, home, 'highp', { jiraPriority: 'Highest' })
    expect(listCases(db).map((c) => c.slug)).toEqual(['highp', 'lowp'])
  })

  it('flags a long-open case with no evidence as idle', () => {
    createCase(db, home, { slug: 'idle-one', title: 'i' })
    db.prepare(`UPDATE cases SET created_at = ? WHERE slug = 'idle-one'`).run(
      new Date(Date.now() - 30 * 86_400_000).toISOString()
    )
    const rec = listCases(db).find((c) => c.slug === 'idle-one')!
    expect(rec.actionItems).toContainEqual(
      expect.objectContaining({ kind: 'idle', severity: 'info' })
    )
  })

  function idOfSlug(slug: string): number {
    return (db.prepare('SELECT id FROM cases WHERE slug = ?').get(slug) as { id: number }).id
  }

  function addEvidenceRow(caseId: number): void {
    db.prepare(
      `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, created_at)
       VALUES (?, 'evidence/x.txt', 'h', 'text', 1, 'upload', 'now')`
    ).run(caseId)
  }

  it('does not flag an old, evidence-free case as idle when it is not open', () => {
    createCase(db, home, { slug: 'idle-closed', title: 'i' })
    db.prepare(`UPDATE cases SET created_at = ? WHERE slug = 'idle-closed'`).run(
      new Date(Date.now() - 30 * 86_400_000).toISOString()
    )
    setCaseStatus(db, home, 'idle-closed', 'closed', 'solved')
    const rec = listCases(db).find((c) => c.slug === 'idle-closed')!
    expect(rec.actionItems).not.toContainEqual(expect.objectContaining({ kind: 'idle' }))
  })

  it('does not flag an old, open case as idle once it has evidence', () => {
    createCase(db, home, { slug: 'idle-with-evidence', title: 'i' })
    db.prepare(`UPDATE cases SET created_at = ? WHERE slug = 'idle-with-evidence'`).run(
      new Date(Date.now() - 30 * 86_400_000).toISOString()
    )
    addEvidenceRow(idOfSlug('idle-with-evidence'))
    const rec = listCases(db).find((c) => c.slug === 'idle-with-evidence')!
    expect(rec.actionItems).not.toContainEqual(expect.objectContaining({ kind: 'idle' }))
  })

  it('does not flag a young, open, evidence-free case as idle', () => {
    createCase(db, home, { slug: 'idle-young', title: 'i' })
    // created_at defaults to "now" — well under the 14-day idle threshold.
    const rec = listCases(db).find((c) => c.slug === 'idle-young')!
    expect(rec.actionItems).not.toContainEqual(expect.objectContaining({ kind: 'idle' }))
  })

  it('getCase never populates actionItems, even when listCases would show one', () => {
    createCase(db, home, { slug: 'contract-1', title: 'c' })
    setCaseSyncState(db, home, 'contract-1', { jiraStatus: 'In Progress' })
    setReviewBaseline(db, home, 'contract-1', {
      status: 'Open',
      commentCount: 0,
      attachmentIds: [],
      capturedAt: '2026-07-01T00:00:00.000Z'
    })
    const listed = listCases(db).find((c) => c.slug === 'contract-1')!
    expect(listed.actionItems).toContainEqual(
      expect.objectContaining({ kind: 'status', severity: 'action' })
    )
    const fetched = getCase(db, 'contract-1')!
    expect(fetched.actionItems).toEqual([])
  })
})

// Finding I1: evidence written during review (e.g. fetch_check_logs mid-review) used to be
// mode-blind — MAX(evidence.created_at) over ALL evidence fed straight into `analyzing`, so a
// review that ingested a CI log and recorded no findings read as "Analyzing" the instant it
// finished. readCaseSignals now splits the evidence query by scope (shared/evidenceScope.ts's
// scopeOfRelPath rule: artifacts/… is review, everything else is investigation), feeding
// review-scoped evidence into `lastReviewEvidenceAt` -> `reviewing` instead.
describe('evidence-scope phase signal (Finding I1)', () => {
  const detection = createDetection()

  it('review-scoped evidence (artifacts/…) reads as reviewing, not analyzing', () => {
    createCase(db, home, { slug: 'REV-1', title: 'r' })
    ingestContent(
      db,
      home,
      detection,
      createImmediateQueue(db, home),
      'REV-1',
      'ci-9-build.log',
      'boom\n',
      'ci',
      {},
      'review'
    )
    expect(getCase(db, 'REV-1')!.phase).toBe('reviewing')
  })

  it('investigation-scoped evidence still reads as analyzing (regression check)', () => {
    createCase(db, home, { slug: 'INV-1', title: 'i' })
    ingestContent(
      db,
      home,
      detection,
      createImmediateQueue(db, home),
      'INV-1',
      'app.log',
      'boom\n',
      'upload'
    )
    expect(getCase(db, 'INV-1')!.phase).toBe('analyzing')
  })

  it('the idle heuristic still counts ALL evidence, across both scopes', () => {
    createCase(db, home, { slug: 'IDLE-SCOPE-1', title: 'i' })
    db.prepare(`UPDATE cases SET created_at = ? WHERE slug = 'IDLE-SCOPE-1'`).run(
      new Date(Date.now() - 30 * 86_400_000).toISOString()
    )
    ingestContent(
      db,
      home,
      detection,
      createImmediateQueue(db, home),
      'IDLE-SCOPE-1',
      'ci-1.log',
      'boom\n',
      'ci',
      {},
      'review'
    )
    // one evidence row exists (review-scoped), so idle must NOT fire — proving evidenceCount
    // still counts it, exactly like an investigation-scoped row would.
    const rec = listCases(db).find((c) => c.slug === 'IDLE-SCOPE-1')!
    expect(rec.actionItems).not.toContainEqual(expect.objectContaining({ kind: 'idle' }))
  })
})

describe('case origin', () => {
  it('defaults a new case to user origin', () => {
    const rec = createCase(db, home, { slug: 'nav-1', title: 'Bearing jumps' })
    expect(rec.origin).toBe('user')
    expect(getCase(db, 'nav-1')?.origin).toBe('user')
  })

  it('stamps an existing case as routine-created, idempotently, without touching updated_at', () => {
    createCase(db, home, { slug: 'routine-sweep', title: 'Routine: Nightly sweep' })
    const before = getCase(db, 'routine-sweep')!.updatedAt
    ensureCaseOrigin(db, 'routine-sweep', 'routine')
    ensureCaseOrigin(db, 'routine-sweep', 'routine')
    expect(getCase(db, 'routine-sweep')?.origin).toBe('routine')
    // origin is a classification, not activity: updated_at feeds formatSyncAge and the `idle`
    // action item, and ensureCaseOrigin runs on every routine run, so touching it here would
    // make every routine case look permanently fresh and silently suppress its idle signal.
    expect(getCase(db, 'routine-sweep')?.updatedAt).toBe(before)
  })

  it('backfills origin from the run table, not from the slug', () => {
    // A human is allowed to name a case `routine-cleanup`. The prefix is a convention; the run
    // table is the record of which cases a routine actually wrote to.
    const older = path.join(home, 'older-origin.db')
    const raw = openDb(older)
    raw.exec(`DROP TABLE cases`)
    raw.exec(`CREATE TABLE cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      jira_key TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      resolution TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
    const insertCase = raw.prepare(
      `INSERT INTO cases (slug, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
    )
    insertCase.run(
      'routine-sweep',
      'Routine: sweep',
      '2026-08-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z'
    )
    insertCase.run(
      'routine-cleanup',
      'Hand-named by a human',
      '2026-08-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z'
    )
    raw
      .prepare(
        `INSERT INTO routine_runs (routine_id, case_slug, status, started_at) VALUES (?, ?, 'ok', ?)`
      )
      .run('sweep', 'routine-sweep', '2026-08-01T00:00:00.000Z')
    raw.close()

    const migrated = openDb(older)
    expect(getCase(migrated, 'routine-sweep')?.origin).toBe('routine')
    expect(getCase(migrated, 'routine-cleanup')?.origin).toBe('user')
    // Simulate a human reclaiming a routine-touched case after the one-time backfill has already
    // run. `routine_runs` for this slug is untouched (still historical fact), so the only thing
    // that can prove the backfill does not re-fire on a later launch is that this override
    // survives a reopen.
    ensureCaseOrigin(migrated, 'routine-sweep', 'user')
    migrated.close()

    // The column guard is what makes the backfill one-time. Without it, a later launch would
    // re-run the `slug IN (...)` UPDATE and stomp the reclaim back to 'routine'.
    const reopened = openDb(older)
    expect(getCase(reopened, 'routine-sweep')?.origin).toBe('user')
    reopened.close()
  })
})

/**
 * Pure, so it is tested without a database — the whole reason it is a separate export. Every
 * rule here is one an accepted suggestion can destroy data by getting wrong.
 */
describe('mergeTags', () => {
  it('replaces every existing tag sharing an incoming tag namespace', () => {
    expect(mergeTags(['severity:low'], ['severity:high'])).toEqual(['severity:high'])
  })

  it('replaces ALL existing tags in that namespace, not just the first', () => {
    expect(mergeTags(['severity:low', 'severity:medium'], ['severity:high'])).toEqual([
      'severity:high'
    ])
  })

  it('leaves other namespaces alone', () => {
    expect(mergeTags(['component:auth', 'severity:low'], ['severity:high'])).toEqual([
      'component:auth',
      'severity:high'
    ])
  })

  it('accumulates a bare tag instead of removing anything', () => {
    expect(mergeTags(['flaky', 'severity:low'], ['urgent'])).toEqual([
      'flaky',
      'severity:low',
      'urgent'
    ])
  })

  it('never lets a bare incoming tag clear the namespaced tags', () => {
    // A bare tag has no namespace, so there is nothing it could be said to replace.
    expect(mergeTags(['severity:low'], ['flaky'])).toEqual(['severity:low', 'flaky'])
  })

  it('keeps BOTH incoming tags when one turn proposes two in one namespace', () => {
    // The model contradicting itself must stay visible on the case, not be silently resolved.
    expect(mergeTags(['severity:low'], ['severity:high', 'severity:medium'])).toEqual([
      'severity:high',
      'severity:medium'
    ])
  })

  it('takes the namespace from the FIRST colon, not the last', () => {
    expect(mergeTags(['owner:alice:smith'], ['owner:bob'])).toEqual(['owner:bob'])
    expect(mergeTags(['owner:alice:smith'], ['owner:alice:jones'])).toEqual(['owner:alice:jones'])
  })

  it('deduplicates within the incoming set and against the existing one', () => {
    expect(mergeTags(['a', 'b'], ['b', 'c', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('deduplicates tags the case already carried twice', () => {
    expect(mergeTags(['a', 'a'], [])).toEqual(['a'])
  })

  it('orders survivors first in their existing order, then new incoming in the given order', () => {
    expect(mergeTags(['z', 'y', 'severity:low'], ['b', 'a', 'severity:high'])).toEqual([
      'z',
      'y',
      'b',
      'a',
      'severity:high'
    ])
  })

  it('treats an empty incoming array as "proposed no tags", never as "clear them"', () => {
    expect(mergeTags(['severity:low', 'flaky'], [])).toEqual(['severity:low', 'flaky'])
  })
})

describe('setCaseTriage', () => {
  it('applies a title and tags and mirrors them into case.json', () => {
    createCase(db, home, { slug: 'abc-1', title: 'ABC-1' })
    const out = setCaseTriage(db, home, 'abc-1', {
      title: 'Crash on empty payload',
      tags: ['severity:high', 'component:auth']
    })
    expect(out.title).toBe('Crash on empty payload')
    expect(out.tags).toEqual(['severity:high', 'component:auth'])
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(home, 'cases', 'abc-1', 'case.json'), 'utf8')
    )
    expect(onDisk.title).toBe('Crash on empty payload')
    expect(onDisk.tags).toEqual(['severity:high', 'component:auth'])
  })

  it('leaves a field alone when the patch omits it', () => {
    createCase(db, home, { slug: 'abc-1', title: 'ABC-1' })
    setCaseTriage(db, home, 'abc-1', { tags: ['severity:low'] })
    const out = getCase(db, 'abc-1')!
    expect(out.title).toBe('ABC-1')
    expect(out.tags).toEqual(['severity:low'])
  })

  it('leaves a field alone when the patch omits it (also checks case.json on disk)', () => {
    createCase(db, home, { slug: 'abc-2', title: 'Original Title' })
    setCaseTriage(db, home, 'abc-2', { tags: ['severity:medium'] })
    // Verify the DB row
    const out = getCase(db, 'abc-2')!
    expect(out.title).toBe('Original Title')
    expect(out.tags).toEqual(['severity:medium'])
    // Verify the on-disk file preserves the title when patch omits it
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(home, 'cases', 'abc-2', 'case.json'), 'utf8')
    )
    expect(onDisk.title).toBe('Original Title')
    expect(onDisk.tags).toEqual(['severity:medium'])
  })

  it('MERGES the accepted tags into the case rather than replacing them, row and case.json', () => {
    // The destructive shape the whole merge exists for: a case that already carries tags (a
    // bundle import, or an earlier accepted suggestion from another routine) is triaged again.
    // Every other test in this block starts from a case with NO tags, which is exactly why the
    // replace-everything behaviour was invisible for the whole increment.
    createCase(db, home, { slug: 'abc-1', title: 'ABC-1' })
    db.prepare(`UPDATE cases SET tags = ? WHERE slug = ?`).run(
      JSON.stringify(['component:auth', 'severity:low', 'flaky']),
      'abc-1'
    )
    const out = setCaseTriage(db, home, 'abc-1', { tags: ['severity:high', 'regression'] })
    expect(out.tags).toEqual(['component:auth', 'flaky', 'severity:high', 'regression'])
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(home, 'cases', 'abc-1', 'case.json'), 'utf8')
    )
    expect(onDisk.tags).toEqual(['component:auth', 'flaky', 'severity:high', 'regression'])
  })

  it('leaves existing tags alone when the suggestion proposes an empty tag list', () => {
    createCase(db, home, { slug: 'abc-1', title: 'ABC-1' })
    db.prepare(`UPDATE cases SET tags = ? WHERE slug = ?`).run(
      JSON.stringify(['severity:low']),
      'abc-1'
    )
    const out = setCaseTriage(db, home, 'abc-1', { title: 'New title', tags: [] })
    expect(out.tags).toEqual(['severity:low'])
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(home, 'cases', 'abc-1', 'case.json'), 'utf8')
    )
    expect(onDisk.tags).toEqual(['severity:low'])
  })

  it('deduplicates tags, so accepting twice does not double them', () => {
    createCase(db, home, { slug: 'abc-1', title: 'ABC-1' })
    const out = setCaseTriage(db, home, 'abc-1', { tags: ['a', 'b', 'a'] })
    expect(out.tags).toEqual(['a', 'b'])
  })

  it('throws on an unknown case rather than writing a phantom row', () => {
    expect(() => setCaseTriage(db, home, 'nope', { title: 'x' })).toThrow(/Unknown case/)
  })

  // Copied from setCaseStatus's rebuild-on-corrupt-file catch, so it needs its own coverage:
  // a copied catch block nobody exercises is how a rebuild path silently rots.
  it('rebuilds case.json from the DB record when the file is corrupt, without derived fields', () => {
    createCase(db, home, { slug: 'abc-1', title: 'ABC-1' })
    const file = path.join(home, 'cases', 'abc-1', 'case.json')
    fs.writeFileSync(file, '{ not valid json')
    const out = setCaseTriage(db, home, 'abc-1', {
      title: 'Rebuilt title',
      tags: ['rebuilt']
    })
    expect(out.title).toBe('Rebuilt title')
    expect(out.tags).toEqual(['rebuilt'])
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(onDisk.title).toBe('Rebuilt title')
    expect(onDisk.tags).toEqual(['rebuilt'])
    expect(onDisk).not.toHaveProperty('id')
    expect(onDisk).not.toHaveProperty('phase')
    expect(onDisk).not.toHaveProperty('actionItems')
  })

  it('does NOT move updated_at, in the row or in case.json', async () => {
    // A bumped timestamp makes the case look freshly modified to a `cases`-scoped sweep
    // (routines/items.ts selects on `updatedAt > lastAttemptAt`), so accepting a suggestion
    // would re-draft the very case that was just accepted, forever.
    createCase(db, home, { slug: 'abc-1', title: 'ABC-1' })
    const before = getCase(db, 'abc-1')!.updatedAt
    await new Promise((r) => setTimeout(r, 5)) // any bump would land after this
    setCaseTriage(db, home, 'abc-1', { title: 'Retitled', tags: ['severity:high'] })
    expect(getCase(db, 'abc-1')!.updatedAt).toBe(before)
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(home, 'cases', 'abc-1', 'case.json'), 'utf8')
    )
    expect(onDisk.updatedAt).toBe(before)
    // The patch itself still applied — this is not "writes nothing".
    expect(getCase(db, 'abc-1')!.title).toBe('Retitled')
    expect(onDisk.title).toBe('Retitled')
  })

  it('mirrors the ROW timestamp into case.json even if the file had drifted', () => {
    createCase(db, home, { slug: 'abc-1', title: 'ABC-1' })
    const file = path.join(home, 'cases', 'abc-1', 'case.json')
    const drifted = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...drifted, updatedAt: '1999-01-01T00:00:00.000Z' }))
    setCaseTriage(db, home, 'abc-1', { tags: ['x'] })
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).updatedAt).toBe(
      getCase(db, 'abc-1')!.updatedAt
    )
  })

  it('sets and clears review state without touching updated_at', () => {
    createCase(db, home, { slug: 'abc-1', title: 'ABC-1' })
    const before = getCase(db, 'abc-1')!.updatedAt
    setCaseReviewState(db, 'abc-1', 'draft')
    expect(getCase(db, 'abc-1')!.reviewState).toBe('draft')
    setCaseReviewState(db, 'abc-1', null)
    expect(getCase(db, 'abc-1')!.reviewState).toBeNull()
    expect(getCase(db, 'abc-1')!.updatedAt).toBe(before)
  })
})

describe('case jira links', () => {
  it('starts empty and round-trips a source link', () => {
    createCase(db, home, { slug: 'NAV-1', title: 'T', jiraKey: 'NAV-1' })
    expect(listCaseJiraLinks(db, 'NAV-1')).toEqual([])

    const link = addCaseJiraLink(db, home, 'NAV-1', 'CUST-9')
    expect(link.key).toBe('CUST-9')
    expect(link.role).toBe('source')
    expect(link.attachmentIds).toEqual([])
    expect(listCaseJiraLinks(db, 'NAV-1').map((l) => l.key)).toEqual(['CUST-9'])
  })

  it('is idempotent on re-add and does not duplicate, keeping the attachment_ids baseline', () => {
    createCase(db, home, { slug: 'NAV-2', title: 'T', jiraKey: 'NAV-2' })
    addCaseJiraLink(db, home, 'NAV-2', 'CUST-9')
    setCaseJiraLinkAttachmentIds(db, 'NAV-2', 'CUST-9', ['a1', 'a2'])
    addCaseJiraLink(db, home, 'NAV-2', 'CUST-9')
    expect(listCaseJiraLinks(db, 'NAV-2')).toHaveLength(1)
    expect(listCaseJiraLinks(db, 'NAV-2')[0].attachmentIds).toEqual(['a1', 'a2'])
  })

  it('stores attachment ids per link', () => {
    createCase(db, home, { slug: 'NAV-3', title: 'T', jiraKey: 'NAV-3' })
    addCaseJiraLink(db, home, 'NAV-3', 'CUST-9')
    addCaseJiraLink(db, home, 'NAV-3', 'CUST-10')
    setCaseJiraLinkAttachmentIds(db, 'NAV-3', 'CUST-9', ['a1', 'a2'])
    const links = listCaseJiraLinks(db, 'NAV-3')
    expect(links.find((l) => l.key === 'CUST-9')!.attachmentIds).toEqual(['a1', 'a2'])
    expect(links.find((l) => l.key === 'CUST-10')!.attachmentIds).toEqual([])
  })

  it('removes a link without touching its sibling', () => {
    createCase(db, home, { slug: 'NAV-4', title: 'T', jiraKey: 'NAV-4' })
    addCaseJiraLink(db, home, 'NAV-4', 'CUST-9')
    addCaseJiraLink(db, home, 'NAV-4', 'CUST-10')
    removeCaseJiraLink(db, home, 'NAV-4', 'CUST-9')
    expect(listCaseJiraLinks(db, 'NAV-4').map((l) => l.key)).toEqual(['CUST-10'])
  })

  it('mirrors links into case.json', () => {
    createCase(db, home, { slug: 'NAV-5', title: 'T', jiraKey: 'NAV-5' })
    addCaseJiraLink(db, home, 'NAV-5', 'CUST-9')
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(caseDir(home, 'NAV-5'), 'case.json'), 'utf8')
    )
    expect(onDisk.jiraSources).toEqual(['CUST-9'])
  })

  it('recovers by rebuilding case.json from the DB record when it is corrupt', () => {
    createCase(db, home, { slug: 'NAV-6', title: 'T', jiraKey: 'NAV-6' })
    const file = path.join(caseDir(home, 'NAV-6'), 'case.json')
    fs.writeFileSync(file, '{ not valid json')

    addCaseJiraLink(db, home, 'NAV-6', 'CUST-9')

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(onDisk.jiraSources).toEqual(['CUST-9'])
    expect(onDisk.title).toBe('T')
  })

  // Fix 4a: the invariant "a ticket cannot be both the case's own ticket and one of its
  // sources" must hold at the data layer, not only inside jiraCases.ts's importSourceTicket
  // caller — a direct accessor call (e.g. from bundle import) must be rejected too.
  it("rejects linking a ticket that is already the case's own jira key", () => {
    createCase(db, home, { slug: 'NAV-7', title: 'T', jiraKey: 'NAV-7' })
    expect(() => addCaseJiraLink(db, home, 'NAV-7', 'NAV-7')).toThrow(/already this case's ticket/)
    expect(listCaseJiraLinks(db, 'NAV-7')).toEqual([])
  })

  it('stores a declined-attachment set per link', () => {
    createCase(db, home, { slug: 'NAV-9', title: 'T', jiraKey: 'NAV-9' })
    addCaseJiraLink(db, home, 'NAV-9', 'CUST-9')
    addCaseJiraLink(db, home, 'NAV-9', 'CUST-10')

    expect(listCaseJiraLinks(db, 'NAV-9').map((l) => l.deselectedIds)).toEqual([[], []])

    setCaseJiraLinkDeselected(db, 'NAV-9', 'CUST-9', ['a1', 'a2'])
    const links = listCaseJiraLinks(db, 'NAV-9')
    expect(links.find((l) => l.key === 'CUST-9')!.deselectedIds).toEqual(['a1', 'a2'])
    expect(links.find((l) => l.key === 'CUST-10')!.deselectedIds).toEqual([])
  })

  it('keeps the declined set independent of the attachment baseline', () => {
    createCase(db, home, { slug: 'NAV-10', title: 'T', jiraKey: 'NAV-10' })
    addCaseJiraLink(db, home, 'NAV-10', 'CUST-9')
    setCaseJiraLinkDeselected(db, 'NAV-10', 'CUST-9', ['a1'])
    setCaseJiraLinkAttachmentIds(db, 'NAV-10', 'CUST-9', ['a1', 'a2'])

    const link = listCaseJiraLinks(db, 'NAV-10')[0]
    expect(link.deselectedIds).toEqual(['a1'])
    expect(link.attachmentIds).toEqual(['a1', 'a2'])
  })
})

describe('ticketProvider', () => {
  it('defaults to jira when not specified', () => {
    const rec = createCase(db, home, { slug: 'CASE-1', title: 'x', jiraKey: 'KAN-1' })
    expect(rec.ticketProvider).toBe('jira')
    expect(getCase(db, 'CASE-1')!.ticketProvider).toBe('jira')
  })

  it('persists github and survives a re-read', () => {
    const rec = createCase(db, home, {
      slug: 'CASE-2',
      title: 'y',
      jiraKey: 'cli/cli#14189',
      ticketProvider: 'github'
    })
    expect(rec.ticketProvider).toBe('github')
    expect(getCase(db, 'CASE-2')!.ticketProvider).toBe('github')
  })

  it('mirrors ticketProvider into case.json', () => {
    createCase(db, home, {
      slug: 'CASE-3',
      title: 'z',
      jiraKey: 'cli/cli#7',
      ticketProvider: 'github'
    })
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(caseDir(home, 'CASE-3'), 'case.json'), 'utf8')
    ) as Record<string, unknown>
    expect(onDisk.ticketProvider).toBe('github')
  })

  it('reads an unknown stored value as jira', () => {
    createCase(db, home, { slug: 'CASE-4', title: 'w' })
    db.prepare(`UPDATE cases SET ticket_provider = 'gitlab' WHERE slug = ?`).run('CASE-4')
    expect(getCase(db, 'CASE-4')!.ticketProvider).toBe('jira')
  })
})
