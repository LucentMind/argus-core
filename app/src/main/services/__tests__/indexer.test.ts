import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { indexEvidenceText, deleteEvidenceIndex } from '../indexer'

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-idx-'))
  return openDb(path.join(dir, 'argus.db'))
}

describe('indexEvidenceText', () => {
  it('chunks by line count with correct line ranges', () => {
    const db = freshDb()
    const text = Array.from({ length: 950 }, (_, i) => `line ${i + 1}`).join('\n')
    const chunks = indexEvidenceText(db, 7, text, 400)
    expect(chunks).toBe(3)
    const rows = db
      .prepare(`SELECT chunk_index, start_line, end_line FROM evidence_fts WHERE evidence_id = 7 ORDER BY chunk_index`)
      .all() as { chunk_index: number; start_line: number; end_line: number }[]
    expect(rows).toEqual([
      { chunk_index: 0, start_line: 1, end_line: 400 },
      { chunk_index: 1, start_line: 401, end_line: 800 },
      { chunk_index: 2, start_line: 801, end_line: 950 }
    ])
  })

  it('is searchable and deletable', () => {
    const db = freshDb()
    indexEvidenceText(db, 3, 'alpha beta\ngamma TileStore error here\n', 400)
    const hit = db
      .prepare(`SELECT evidence_id FROM evidence_fts WHERE evidence_fts MATCH ?`)
      .get('"TileStore error"') as { evidence_id: number } | undefined
    expect(hit?.evidence_id).toBe(3)
    deleteEvidenceIndex(db, 3)
    const after = db.prepare(`SELECT count(*) AS n FROM evidence_fts WHERE evidence_id = 3`).get() as { n: number }
    expect(after.n).toBe(0)
  })
})
