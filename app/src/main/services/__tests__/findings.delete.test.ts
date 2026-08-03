import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase, getCase } from '../caseService'
import { caseDir } from '../paths'
import { deleteFinding } from '../findings'

function insertFinding(db: ReturnType<typeof openDb>, caseId: number, summary: string): number {
  const now = new Date().toISOString()
  const r = db
    .prepare(
      `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at) VALUES (?,?,?,?, 'pending', ?)`
    )
    .run(caseId, 1, 2, summary, now)
  return Number(r.lastInsertRowid)
}

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'argus-findings-delete-'))
}

describe('deleteFinding', () => {
  it('splices exactly its own block, audits, and throws on re-delete', () => {
    const home = tmpHome()
    const db = openDb(path.join(home, 'argus.db'))
    createCase(db, home, { slug: 'c1', title: 'C1' })
    const caseId = getCase(db, 'c1')!.id
    const id1 = insertFinding(db, caseId, 'Finding one')
    const id2 = insertFinding(db, caseId, 'Finding two')
    const id3 = insertFinding(db, caseId, 'Finding three')
    const mdPath = path.join(caseDir(home, 'c1'), 'findings.md')
    fs.writeFileSync(
      mdPath,
      [
        `# Findings — c1`,
        '',
        `<!-- finding:${id1} -->`,
        '## Finding one',
        '_now · session 1_',
        '',
        'Body one.',
        '',
        `<!-- finding:${id2} -->`,
        '## Finding two',
        '_now · session 1_',
        '',
        'Body two.',
        '',
        `<!-- finding:${id3} -->`,
        '## Finding three',
        '_now · session 1_',
        '',
        'Body three.',
        ''
      ].join('\n')
    )

    const res = deleteFinding(db, home, id2)
    expect(res).toEqual({ deleted: true })

    const md = fs.readFileSync(mdPath, 'utf8')
    expect(md).not.toContain(`<!-- finding:${id2} -->`)
    expect(md).not.toContain('Body two.')
    expect(md).toContain(`<!-- finding:${id1} -->`)
    expect(md).toContain(`<!-- finding:${id3} -->`)

    expect(db.prepare(`SELECT id FROM findings WHERE id=?`).get(id2)).toBeUndefined()
    expect(db.prepare(`SELECT id FROM findings WHERE id=?`).get(id1)).not.toBeUndefined()
    expect(db.prepare(`SELECT id FROM findings WHERE id=?`).get(id3)).not.toBeUndefined()

    const audit = fs.readFileSync(path.join(home, '.audit', 'deletions.jsonl'), 'utf8')
    expect(audit).toContain('finding.delete')

    expect(() => deleteFinding(db, home, id2)).toThrow()

    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('throws on an unknown id without touching findings.md', () => {
    const home = tmpHome()
    const db = openDb(path.join(home, 'argus.db'))
    createCase(db, home, { slug: 'c1', title: 'C1' })
    expect(() => deleteFinding(db, home, 999)).toThrow()
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  })
})
