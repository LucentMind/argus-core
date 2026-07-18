import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { ingestArtifact } from '../ingest'
import { createDetection } from '../packs/detection'
import { openTextDoc, readTextDocLines } from '../textdoc'
import { __clearIndexCacheForTests } from '../lineIndex'
import { MAX_READ_BYTES } from '../search'

let tmp: string, argusHome: string, db: DatabaseSync
const detection = createDetection()

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-td-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  createCase(db, argusHome, { slug: 'NAV-9', title: 't' })
  __clearIndexCacheForTests()
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function ingestFile(name: string, content: string): number {
  const src = path.join(tmp, name)
  fs.writeFileSync(src, content)
  return ingestArtifact(db, argusHome, detection, 'NAV-9', src).id
}

describe('openTextDoc', () => {
  it('small evidence: returns whole content, totalLines, lang', async () => {
    const id = ingestFile('small.log', 'one\ntwo\nthree\n')
    const r = await openTextDoc(db, argusHome, { kind: 'evidence', evidenceId: id })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.whole).toBe('one\ntwo\nthree\n')
    expect(r.totalLines).toBe(3)
    expect(r.title).toBe('NAV-9 / evidence/small.log')
  })

  it('large evidence: no whole, correct totalLines (index from ingest reused)', async () => {
    const line = 'y'.repeat(1024) + '\n'
    const count = Math.ceil(MAX_READ_BYTES / line.length) + 50
    const id = ingestFile('big.log', line.repeat(count))
    const r = await openTextDoc(db, argusHome, { kind: 'evidence', evidenceId: id })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.whole).toBeUndefined()
    expect(r.totalLines).toBe(count)
  })

  it('unknown evidence / unlinked repo → error results', async () => {
    expect(await openTextDoc(db, argusHome, { kind: 'evidence', evidenceId: 999 })).toEqual({
      ok: false,
      reason: 'not-found'
    })
    expect(
      await openTextDoc(db, argusHome, {
        kind: 'repo',
        caseSlug: 'NAV-9',
        repoName: 'nope',
        relPath: 'a.ts'
      })
    ).toEqual({ ok: false, reason: 'repo-not-linked' })
  })
})

describe('readTextDocLines', () => {
  it('serves pages from a large evidence file', async () => {
    const count = Math.ceil(MAX_READ_BYTES / 11) + 500 // 11-byte lines
    const content =
      Array.from({ length: count }, (_, i) => String(i + 1).padStart(10, '0')).join('\n') + '\n'
    const id = ingestFile('pages.log', content)
    const r = await readTextDocLines(
      db,
      argusHome,
      { kind: 'evidence', evidenceId: id },
      1001,
      1003
    )
    expect(r).toEqual({ from: 1001, lines: ['0000001001', '0000001002', '0000001003'] })
  })
})
