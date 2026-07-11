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

function addFinding(summary: string): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO findings (case_id, summary, review_state, created_at) VALUES (?, ?, 'pending', ?)`
  ).run(caseId, summary, now)
}

describe('clearFindings', () => {
  it('deletes all rows, resets findings.md to the seeded header, audits the count', () => {
    addFinding('Root cause A')
    addFinding('Root cause B')
    const md = path.join(argusHome, 'cases', 'NAV-1', 'findings.md')
    fs.appendFileSync(md, '\n## Root cause A\nbody\n')

    const r = clearFindings(db, argusHome, 'NAV-1')

    expect(r.cleared).toBe(2)
    expect(listFindings(db, 'NAV-1')).toHaveLength(0)
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
