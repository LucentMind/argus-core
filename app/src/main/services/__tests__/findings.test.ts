import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase, getCase } from '../caseService'
import { caseDir } from '../paths'
import { listFindings, reviewFinding, parseFindingBodies } from '../findings'

function insertFinding(db: ReturnType<typeof openDb>, caseId: number, summary: string): number {
  const now = new Date().toISOString()
  const r = db
    .prepare(
      `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at) VALUES (?,?,?,?, 'pending', ?)`
    )
    .run(caseId, 1, 2, summary, now)
  return Number(r.lastInsertRowid)
}

describe('parseFindingBodies', () => {
  it('maps marker id → body, stripping heading and meta lines', () => {
    const md = [
      '# Findings — c1',
      '',
      '<!-- finding:5 -->',
      '## Null deref',
      '_2026-07-15T09:00:00.000Z · session 4_',
      '',
      'The body line. See [a.ts:1].',
      ''
    ].join('\n')
    const map = parseFindingBodies(md)
    expect(map.get(5)).toBe('The body line. See [a.ts:1].')
  })

  it('returns an empty map when there are no markers', () => {
    expect(parseFindingBodies('# Findings — c1\n\njust prose\n').size).toBe(0)
  })
})

describe('findings service', () => {
  it('lists findings and attaches bodies parsed from findings.md', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-findings-'))
    const db = openDb(path.join(home, 'argus.db'))
    createCase(db, home, { slug: 'c1', title: 'C1' })
    const caseId = getCase(db, 'c1')!.id
    const id = insertFinding(db, caseId, 'Root cause X')
    fs.writeFileSync(
      path.join(caseDir(home, 'c1'), 'findings.md'),
      `# Findings — c1\n\n<!-- finding:${id} -->\n## Root cause X\n_now · session 1_\n\nThe detailed body.\n`
    )

    const list = listFindings(db, home, 'c1')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id, summary: 'Root cause X', reviewState: 'pending' })
    expect(list[0].body).toBe('The detailed body.')

    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('leaves body undefined for a marker-less (legacy) finding', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-findings-'))
    const db = openDb(path.join(home, 'argus.db'))
    createCase(db, home, { slug: 'c1', title: 'C1' })
    const caseId = getCase(db, 'c1')!.id
    insertFinding(db, caseId, 'Legacy finding')
    // findings.md still has only the seeded header — no marker
    const list = listFindings(db, home, 'c1')
    expect(list[0].body).toBeUndefined()
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('reviews a finding (unchanged)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-findings-'))
    const db = openDb(path.join(home, 'argus.db'))
    createCase(db, home, { slug: 'c1', title: 'C1' })
    const caseId = getCase(db, 'c1')!.id
    const id = insertFinding(db, caseId, 'Root cause X')
    const reviewed = reviewFinding(db, id, 'accepted')
    expect(reviewed?.reviewState).toBe('accepted')
    expect(reviewed?.reviewedAt).not.toBeNull()
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('rejects an invalid review state', () => {
    const db = openDb(':memory:')
    // @ts-expect-error invalid state
    expect(() => reviewFinding(db, 1, 'bogus')).toThrow()
  })
})
