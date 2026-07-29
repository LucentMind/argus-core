import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { clearFindings, listFindings } from '../findings'
import { readDeletionAudit } from '../deletionAudit'

let tmp: string, argusHome: string, db: DatabaseSync, caseId: number

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-clrf-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  caseId = createCase(db, argusHome, { slug: 'NAV-1', title: 't' }).id
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function addSession(mode: 'investigation' | 'review'): number {
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO sessions (case_id, mode, created_at, updated_at) VALUES (?,?,?,?)`).run(
    caseId,
    mode,
    now,
    now
  )
  return Number(db.prepare(`SELECT last_insert_rowid() AS id`).get()!.id)
}

function addFinding(summary: string, sessionId: number | null = null): number {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO findings (case_id, session_id, summary, review_state, created_at) VALUES (?, ?, ?, 'pending', ?)`
  ).run(caseId, sessionId, summary, now)
  return Number(db.prepare(`SELECT last_insert_rowid() AS id`).get()!.id)
}

describe('clearFindings', () => {
  it('deletes all rows, resets findings.md to the seeded header, audits the count', () => {
    addFinding('Root cause A')
    addFinding('Root cause B')
    const md = path.join(argusHome, 'cases', 'NAV-1', 'findings.md')
    fs.appendFileSync(md, '\n## Root cause A\nbody\n')

    const r = clearFindings(db, argusHome, 'NAV-1')

    expect(r.cleared).toBe(2)
    expect(listFindings(db, argusHome, 'NAV-1')).toHaveLength(0)
    expect(fs.readFileSync(md, 'utf8')).toBe('# Findings — NAV-1\n')
    const audit = readDeletionAudit(argusHome)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      op: 'findings.clear',
      caseSlug: 'NAV-1',
      detail: { cleared: 2 }
    })
  })

  it('clearing an empty case is a no-op that still resets the file and audits 0', () => {
    const r = clearFindings(db, argusHome, 'NAV-1')
    expect(r.cleared).toBe(0)
    expect(readDeletionAudit(argusHome)[0].detail).toEqual({ cleared: 0 })
  })

  it('throws for an unknown case', () => {
    expect(() => clearFindings(db, argusHome, 'NOPE')).toThrow(/unknown case/i)
  })
})

describe('clearFindings scoped to a mode', () => {
  it('deletes only that mode, strips only its findings.md sections, audits the mode', () => {
    const inv = addSession('investigation')
    const rev = addSession('review')
    const invId = addFinding('Root cause A', inv)
    const revId = addFinding('Bad guard', rev)
    const md = path.join(argusHome, 'cases', 'NAV-1', 'findings.md')
    fs.appendFileSync(
      md,
      `\n<!-- finding:${invId} -->\n## Root cause A\ninv body\n<!-- finding:${revId} -->\n## Bad guard\nrev body\n`
    )

    const r = clearFindings(db, argusHome, 'NAV-1', 'review')

    expect(r.cleared).toBe(1)
    const left = listFindings(db, argusHome, 'NAV-1')
    expect(left).toHaveLength(1)
    expect(left[0].summary).toBe('Root cause A')
    const after = fs.readFileSync(md, 'utf8')
    expect(after).toContain('inv body')
    expect(after).not.toContain('rev body')
    expect(readDeletionAudit(argusHome)[0]).toMatchObject({
      op: 'findings.clear',
      caseSlug: 'NAV-1',
      detail: { cleared: 1, mode: 'review' }
    })
  })

  it('treats session-less findings as investigation (the toRow rule)', () => {
    addFinding('orphan') // no session
    const rev = addSession('review')
    addFinding('review one', rev)

    expect(clearFindings(db, argusHome, 'NAV-1', 'investigation').cleared).toBe(1)
    const left = listFindings(db, argusHome, 'NAV-1')
    expect(left).toHaveLength(1)
    expect(left[0].summary).toBe('review one')
  })

  it('mode-scoped clear with no findings.md is fine', () => {
    const rev = addSession('review')
    addFinding('review one', rev)
    const md = path.join(argusHome, 'cases', 'NAV-1', 'findings.md')
    fs.rmSync(md, { force: true })
    expect(clearFindings(db, argusHome, 'NAV-1', 'review').cleared).toBe(1)
    expect(fs.existsSync(md)).toBe(false) // not resurrected
  })

  it('propagates a non-ENOENT findings.md failure instead of swallowing it', () => {
    const rev = addSession('review')
    addFinding('review one', rev)
    const md = path.join(argusHome, 'cases', 'NAV-1', 'findings.md')
    fs.rmSync(md, { force: true })
    fs.mkdirSync(md) // readFileSync now throws EISDIR, which must NOT be swallowed
    expect(() => clearFindings(db, argusHome, 'NAV-1', 'review')).toThrow()
  })
})
