import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { ingestContent, ingestDerived, deleteEvidence, listEvidence } from '../ingest'
import { readDeletionAudit } from '../deletionAudit'
import { createDetection } from '../packs/detection'
import { samplePackRegistry } from '../packs/__tests__/fixtures'

let tmp: string, argusHome: string, db: DatabaseSync
const detection = createDetection(samplePackRegistry())

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-delev-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  createCase(db, argusHome, { slug: 'NAV-1', title: 't' })
  createCase(db, argusHome, { slug: 'NAV-2', title: 't2' })
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const evDir = (slug: string): string => path.join(argusHome, 'cases', slug, 'evidence')

function ftsCount(evidenceId: number): number {
  return Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM evidence_fts WHERE evidence_id = ?`)
        .get(evidenceId) as {
        n: number
      }
    ).n
  )
}

describe('deleteEvidence', () => {
  it('deletes the file, .meta sidecar, FTS rows, and DB row; audits relPath + sha256', () => {
    const rec = ingestContent(
      db,
      argusHome,
      detection,
      'NAV-1',
      'log.txt',
      'hello\nworld\n',
      'upload'
    )
    expect(ftsCount(rec.id)).toBeGreaterThan(0)

    const r = deleteEvidence(db, argusHome, 'NAV-1', rec.id)

    expect(r.deleted).toEqual([{ id: rec.id, relPath: 'evidence/log.txt', sha256: rec.sha256 }])
    expect(fs.existsSync(path.join(evDir('NAV-1'), 'log.txt'))).toBe(false)
    expect(fs.existsSync(path.join(evDir('NAV-1'), '.meta', 'log.txt.json'))).toBe(false)
    expect(ftsCount(rec.id)).toBe(0)
    expect(listEvidence(db, 'NAV-1')).toHaveLength(0)
    const audit = readDeletionAudit(argusHome)
    expect(audit).toHaveLength(1)
    expect(audit[0].op).toBe('evidence.delete')
    expect(audit[0].detail.deleted).toEqual([
      { id: rec.id, relPath: 'evidence/log.txt', sha256: rec.sha256 }
    ])
  })

  it('cascades to derived children and grandchildren', () => {
    const parent = ingestContent(db, argusHome, detection, 'NAV-1', 'trace.txt', 'raw\n', 'upload')
    const derivedDir = path.join(evDir('NAV-1'), '.derived')
    fs.mkdirSync(derivedDir, { recursive: true })
    fs.writeFileSync(path.join(derivedDir, 'trace.extracted.txt'), 'derived text\n')
    const child = ingestDerived(
      db,
      argusHome,
      'NAV-1',
      path.join(derivedDir, 'trace.extracted.txt'),
      parent.id
    )
    fs.writeFileSync(path.join(derivedDir, 'trace.summary.txt'), 'summary\n')
    const grandchild = ingestDerived(
      db,
      argusHome,
      'NAV-1',
      path.join(derivedDir, 'trace.summary.txt'),
      child.id
    )

    const r = deleteEvidence(db, argusHome, 'NAV-1', parent.id)

    expect(new Set(r.deleted.map((d) => d.id))).toEqual(
      new Set([parent.id, child.id, grandchild.id])
    )
    expect(listEvidence(db, 'NAV-1')).toHaveLength(0)
    expect(fs.existsSync(path.join(derivedDir, 'trace.extracted.txt'))).toBe(false)
    expect(fs.existsSync(path.join(derivedDir, 'trace.summary.txt'))).toBe(false)
    expect(
      fs.existsSync(path.join(evDir('NAV-1'), '.meta', '.derived', 'trace.extracted.txt.json'))
    ).toBe(false)
    expect(ftsCount(child.id)).toBe(0)
    expect(ftsCount(grandchild.id)).toBe(0)
  })

  it('deleting a derived child leaves the parent alone', () => {
    const parent = ingestContent(db, argusHome, detection, 'NAV-1', 'trace.txt', 'raw\n', 'upload')
    const derivedDir = path.join(evDir('NAV-1'), '.derived')
    fs.mkdirSync(derivedDir, { recursive: true })
    fs.writeFileSync(path.join(derivedDir, 'trace.extracted.txt'), 'derived\n')
    const child = ingestDerived(
      db,
      argusHome,
      'NAV-1',
      path.join(derivedDir, 'trace.extracted.txt'),
      parent.id
    )

    deleteEvidence(db, argusHome, 'NAV-1', child.id)

    const left = listEvidence(db, 'NAV-1')
    expect(left.map((e) => e.id)).toEqual([parent.id])
    expect(fs.existsSync(path.join(evDir('NAV-1'), 'trace.txt'))).toBe(true)
  })

  it('rejects an evidence id belonging to another case, and an unknown id', () => {
    const foreign = ingestContent(db, argusHome, detection, 'NAV-2', 'x.txt', 'x\n', 'upload')
    expect(() => deleteEvidence(db, argusHome, 'NAV-1', foreign.id)).toThrow(/unknown evidence/i)
    expect(() => deleteEvidence(db, argusHome, 'NAV-1', 999999)).toThrow(/unknown evidence/i)
    expect(listEvidence(db, 'NAV-2')).toHaveLength(1) // untouched
  })
})
