import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import {
  finalizeEvidenceIndexMigration,
  legacyIndexRemaining,
  migrateOneEvidence,
  runEvidenceIndexMigration
} from '../evidenceIndexMigration'
import { withFtsSavepoint } from '../ftsIndex'

let tmp: string
let seq = 0
const opened: DatabaseSync[] = []

afterEach(() => {
  for (const d of opened.splice(0)) d.close()
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

function openTestDb(): DatabaseSync {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-migration-'))
  const database = openDb(path.join(tmp, 'argus.db'))
  opened.push(database)
  return database
}

function seedEvidence(db: DatabaseSync): number {
  seq++
  db.prepare(
    `INSERT OR IGNORE INTO cases (id, slug, title, created_at, updated_at)
     VALUES (1,'M','M','','')`
  ).run()
  const res = db
    .prepare(
      `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, created_at)
       VALUES (1, ?, 'h', 'log', 1, '')`
    )
    .run(`evidence/m${seq}.log`)
  return Number(res.lastInsertRowid)
}

function seedLegacy(
  db: DatabaseSync,
  evidenceId: number,
  chunks: { text: string; from: number; to: number }[]
): void {
  chunks.forEach((c, i) => {
    withFtsSavepoint(db, () => {
      const rowid = db
        .prepare(
          `INSERT INTO evidence_fts (content, evidence_id, chunk_index, start_line, end_line)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(c.text, evidenceId, i, c.from, c.to).lastInsertRowid
      db.prepare(`INSERT INTO evidence_fts_map (fts_rowid, evidence_id) VALUES (?, ?)`).run(
        rowid,
        evidenceId
      )
    })
  })
}

describe('evidence index migration', () => {
  it('moves one evidence row, preserving chunk boundaries exactly', () => {
    const db = openTestDb()
    const id = seedEvidence(db)
    seedLegacy(db, id, [
      { text: 'first chunk text', from: 1, to: 400 },
      { text: 'second chunk text', from: 401, to: 640 }
    ])

    expect(migrateOneEvidence(db)).toBe(id)

    const map = db
      .prepare(
        `SELECT chunk_index, start_line, end_line FROM evidence_index_map
         WHERE evidence_id = ? ORDER BY chunk_index`
      )
      .all(id) as unknown as { chunk_index: number; start_line: number; end_line: number }[]
    expect(map).toEqual([
      { chunk_index: 0, start_line: 1, end_line: 400 },
      { chunk_index: 1, start_line: 401, end_line: 640 }
    ])
  })

  it('leaves the legacy table empty for the migrated row', () => {
    const db = openTestDb()
    const id = seedEvidence(db)
    seedLegacy(db, id, [{ text: 'only chunk', from: 1, to: 10 }])
    migrateOneEvidence(db)
    expect(
      (
        db.prepare(`SELECT count(*) AS n FROM evidence_fts_map WHERE evidence_id = ?`).get(id) as {
          n: number
        }
      ).n
    ).toBe(0)
    expect((db.prepare(`SELECT count(*) AS n FROM evidence_fts`).get() as { n: number }).n).toBe(0)
  })

  it('keeps the migrated text searchable', () => {
    const db = openTestDb()
    const id = seedEvidence(db)
    seedLegacy(db, id, [{ text: 'connection refused by peer', from: 1, to: 1 }])
    migrateOneEvidence(db)
    const hit = db
      .prepare(`SELECT rowid FROM evidence_index WHERE evidence_index MATCH ?`)
      .all('"connection refused"') as unknown as { rowid: number }[]
    expect(hit).toHaveLength(1)
  })

  it('returns null and moves nothing when the legacy table is empty', () => {
    const db = openTestDb()
    expect(migrateOneEvidence(db)).toBeNull()
    expect(legacyIndexRemaining(db)).toBe(0)
  })

  it('is resumable: a partial run leaves the remainder to a later run', async () => {
    const db = openTestDb()
    const ids = [seedEvidence(db), seedEvidence(db), seedEvidence(db)]
    for (const id of ids) seedLegacy(db, id, [{ text: `text for ${id}`, from: 1, to: 5 }])

    let seen = 0
    await runEvidenceIndexMigration(db, { shouldStop: () => ++seen > 1 })
    expect(legacyIndexRemaining(db)).toBe(2)

    await runEvidenceIndexMigration(db)
    expect(legacyIndexRemaining(db)).toBe(0)
    expect(
      (db.prepare(`SELECT count(*) AS n FROM evidence_index_map`).get() as { n: number }).n
    ).toBe(3)
  })

  it('reports progress against the starting total', async () => {
    const db = openTestDb()
    for (const id of [seedEvidence(db), seedEvidence(db)])
      seedLegacy(db, id, [{ text: 'x', from: 1, to: 1 }])
    const seen: [number, number][] = []
    await runEvidenceIndexMigration(db, { onProgress: (d, t) => seen.push([d, t]) })
    expect(seen).toEqual([
      [1, 2],
      [2, 2]
    ])
  })

  // Load-bearing: each evidence row moves inside ONE withFtsSavepoint. A torn migration
  // would leave some chunks in evidence_index and the rest still in evidence_fts, which
  // makes search return the same file twice with different line ranges -- and any
  // evidence_index_map row left unpaired by a crash is exactly what the boot orphan
  // sweep (deleteOrphanEvidenceIndex) would then delete.
  it('rolls back the whole row when a chunk in the middle fails, leaving the legacy row untouched', () => {
    const db = openTestDb()
    const id = seedEvidence(db)
    seedLegacy(db, id, [
      { text: 'chunk zero', from: 1, to: 10 },
      { text: 'chunk one', from: 11, to: 20 },
      { text: 'chunk two', from: 21, to: 30 }
    ])
    // Fail the third chunk's map insert, standing in for a crash mid-row.
    db.exec(
      `CREATE TRIGGER argus_test_block_third_map BEFORE INSERT ON evidence_index_map
       WHEN (SELECT COUNT(*) FROM evidence_index_map) = 2
       BEGIN SELECT RAISE(ABORT, 'interrupted mid-row'); END`
    )

    expect(() => migrateOneEvidence(db)).toThrow(/interrupted/)

    expect(
      (
        db.prepare(`SELECT count(*) AS n FROM evidence_fts WHERE evidence_id = ?`).get(id) as {
          n: number
        }
      ).n
    ).toBe(3)
    expect(
      (
        db
          .prepare(`SELECT count(*) AS n FROM evidence_index_map WHERE evidence_id = ?`)
          .get(id) as { n: number }
      ).n
    ).toBe(0)
  })
})

describe('finalize', () => {
  it('refuses to drop anything while legacy rows remain', () => {
    const db = openTestDb()
    seedLegacy(db, seedEvidence(db), [{ text: 'still here', from: 1, to: 1 }])
    expect(finalizeEvidenceIndexMigration(db)).toBe(false)
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE name = 'evidence_fts'`).get()
    ).toBeTruthy()
  })

  it('drops both legacy tables once nothing is left', async () => {
    const db = openTestDb()
    seedLegacy(db, seedEvidence(db), [{ text: 'move me', from: 1, to: 1 }])
    await runEvidenceIndexMigration(db)
    expect(finalizeEvidenceIndexMigration(db)).toBe(true)
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'evidence_fts'`).get()).toBe(
      undefined
    )
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'evidence_fts_map'`).get()).toBe(
      undefined
    )
  })

  it('leaves the migrated content searchable afterwards', async () => {
    const db = openTestDb()
    seedLegacy(db, seedEvidence(db), [{ text: 'survivor token', from: 1, to: 1 }])
    await runEvidenceIndexMigration(db)
    finalizeEvidenceIndexMigration(db)
    const hits = db
      .prepare(`SELECT rowid FROM evidence_index WHERE evidence_index MATCH ?`)
      .all('survivor') as unknown as { rowid: number }[]
    expect(hits).toHaveLength(1)
  })

  it('enables incremental auto_vacuum', async () => {
    const db = openTestDb()
    await runEvidenceIndexMigration(db)
    finalizeEvidenceIndexMigration(db)
    const mode = db.prepare(`PRAGMA auto_vacuum`).get() as { auto_vacuum: number }
    expect(mode.auto_vacuum).toBe(2) // 2 = INCREMENTAL
  })
})
