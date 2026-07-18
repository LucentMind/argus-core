import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { ingestArtifact } from '../../ingest'
import { createDetection } from '../../packs/detection'
import { argusToolHandlers } from '../nativeTools'
import { __clearIndexCacheForTests } from '../../lineIndex'

let tmp: string, argusHome: string, db: DatabaseSync, evidenceId: number
let handlers: ReturnType<typeof argusToolHandlers>
const detection = createDetection()

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rl-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  const rec = createCase(db, argusHome, { slug: 'NAV-3', title: 't' })
  const src = path.join(tmp, 'big.log')
  const lines = Array.from({ length: 10_000 }, (_, i) =>
    i % 1000 === 500 ? `ERROR at step ${i + 1}` : `trace ${i + 1}`
  )
  fs.writeFileSync(src, lines.join('\n') + '\n')
  evidenceId = ingestArtifact(db, argusHome, detection, 'NAV-3', src).id
  __clearIndexCacheForTests()
  handlers = argusToolHandlers({
    db,
    argusHome,
    detection,
    caseId: rec.id,
    caseSlug: 'NAV-3',
    sessionId: 1,
    emitFinding: vi.fn()
  })
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('read_lines', () => {
  it('returns numbered lines for an arbitrary range', async () => {
    // fixture puts ERROR on lines 501, 1501, 2501, … (i % 1000 === 500 → line i+1)
    const out = await handlers.read_lines({ evidence_id: evidenceId, from: 1499, to: 1503 })
    expect(out).toContain('lines 1499-1503 of 10000')
    expect(out).toContain('1501\tERROR at step 1501')
  })

  it('caps at 500 lines and clamps past EOF', async () => {
    const out = await handlers.read_lines({ evidence_id: evidenceId, from: 1, to: 9999 })
    expect(out.trim().split('\n')).toHaveLength(501) // header + 500 lines
    const eof = await handlers.read_lines({ evidence_id: evidenceId, from: 99999, to: 99999 })
    expect(eof).toContain('does not exist')
  })

  it('rejects unknown evidence', async () => {
    await expect(handlers.read_lines({ evidence_id: 424242, from: 1, to: 2 })).rejects.toThrow(
      /Unknown|not-found/i
    )
  })
})

describe('grep_lines', () => {
  it('finds matches with totalLines context', async () => {
    const out = await handlers.grep_lines({ evidence_id: evidenceId, query: 'ERROR' })
    expect(out).toContain('10 matches')
    expect(out).toContain('of 10000')
    expect(out).toContain('501\tERROR at step 501')
  })

  it('range-scopes to the second half and paginates with nextFrom', async () => {
    const half = await handlers.grep_lines({
      evidence_id: evidenceId,
      query: 'ERROR',
      from_line: 5001
    })
    expect(half).toContain('5 matches')
    const paged = await handlers.grep_lines({
      evidence_id: evidenceId,
      query: 'trace',
      max_results: 100
    })
    expect(paged).toContain('[capped — continue with from_line:')
  })
})
