import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import {
  createCase,
  listCases,
  getCase,
  setCaseJira,
  setCaseJiraDeselected,
  setCaseStatus,
  maybeAdvanceToAnalyzing,
  setCaseSyncState,
  setReviewBaseline
} from '../caseService'
import { caseDir } from '../paths'
import type { DatabaseSync } from 'node:sqlite'

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
    const rec = setCaseStatus(db, home, 'c4', 'analyzing', 'duplicate')
    expect(rec.status).toBe('analyzing')
    expect(rec.resolution).toBeNull()
    const onDisk = JSON.parse(fs.readFileSync(path.join(caseDir(home, 'c4'), 'case.json'), 'utf8'))
    expect(onDisk.resolution).toBeNull()
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
})

describe('maybeAdvanceToAnalyzing', () => {
  function idOf(slug: string): number {
    return (db.prepare('SELECT id FROM cases WHERE slug = ?').get(slug) as { id: number }).id
  }
  function addEvidence(caseId: number): void {
    db.prepare(
      `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, created_at)
       VALUES (?, 'evidence/x.txt', 'h', 'text', 1, 'upload', 'now')`
    ).run(caseId)
  }
  function addTurn(caseId: number): void {
    db.prepare(
      `INSERT INTO sessions (case_id, created_at, updated_at) VALUES (?, 'now', 'now')`
    ).run(caseId)
    db.prepare(
      `INSERT INTO turns (case_id, session_id, turn_index, status, created_at)
       VALUES (?, 1, 0, 'done', 'now')`
    ).run(caseId)
  }

  it('advances to analyzing when evidence and a turn both exist', () => {
    createCase(db, home, { slug: 'a1', title: 'A1' })
    const id = idOf('a1')
    addEvidence(id)
    addTurn(id)
    maybeAdvanceToAnalyzing(db, home, id)
    expect(getCase(db, 'a1')!.status).toBe('analyzing')
  })

  it('does nothing with evidence but no turn', () => {
    createCase(db, home, { slug: 'a2', title: 'A2' })
    const id = idOf('a2')
    addEvidence(id)
    maybeAdvanceToAnalyzing(db, home, id)
    expect(getCase(db, 'a2')!.status).toBe('open')
  })

  it('does not downgrade a closed case', () => {
    createCase(db, home, { slug: 'a3', title: 'A3' })
    const id = idOf('a3')
    addEvidence(id)
    addTurn(id)
    setCaseStatus(db, home, 'a3', 'closed', 'solved')
    maybeAdvanceToAnalyzing(db, home, id)
    expect(getCase(db, 'a3')!.status).toBe('closed')
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
})
