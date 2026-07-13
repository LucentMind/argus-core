import { it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, getCase } from '../../caseService'
import { caseDir } from '../../paths'
import { appendFinding } from '../nativeTools'

let home: string, db: DatabaseSync

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-finding-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'CASE-A', title: 'A' })
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

it('appends a findings.md block and inserts a pending findings row', () => {
  const c = getCase(db, 'CASE-A')!
  const { findingId, block } = appendFinding(
    { db, argusHome: home, caseId: c.id, caseSlug: 'CASE-A', sessionId: 5, turnId: null },
    { title: 'Race in tile cache', markdown: 'See [evidence/log.txt:12]' }
  )
  expect(findingId).toBeGreaterThan(0)
  expect(block).toContain('## Race in tile cache')
  expect(fs.readFileSync(path.join(caseDir(home, 'CASE-A'), 'findings.md'), 'utf8')).toContain(
    'Race in tile cache'
  )
  const row = db.prepare('SELECT summary, review_state FROM findings WHERE id = ?').get(findingId) as
    | { summary: string; review_state: string }
    | undefined
  expect(row).toEqual({ summary: 'Race in tile cache', review_state: 'pending' })
})
