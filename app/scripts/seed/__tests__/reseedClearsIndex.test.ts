import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../../src/main/services/db'
import { indexEvidenceText } from '../../../src/main/services/indexer'
// @ts-expect-error -- plain .mjs fixture module, no types
import { createCtx } from '../ctx.mjs'
// @ts-expect-error -- plain .mjs fixture module, no types
import { seedCases } from '../cases.mjs'

/**
 * The seed script's documented workflow is seed -> boot -> Rescan -> possibly re-seed, and
 * a Rescan writes the CURRENT generation (evidence_index + evidence_index_map). The
 * re-seed's own cleanup used to clear only the legacy evidence_fts pair, so every re-seed
 * left evidence_index rows behind whose map rows named evidence ids the cases cascade had
 * just deleted: invisible to search (its `evidence` join drops them) and never reclaimed by
 * the boot sweep, which only removes index rows that have NO map row at all.
 *
 * Since db.ts stopped declaring the legacy pair, this database does not have it — so this
 * also covers the second half: the cleanup must not throw on its absence.
 */
let tmp = ''
let db: DatabaseSync | null = null

afterEach(() => {
  db?.close()
  db = null
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = ''
})

function seedOnce(argusHome: string, database: DatabaseSync): void {
  const ctx = createCtx({ argusHome, db: database })
  const repoDir = path.join(argusHome, 'repo')
  fs.mkdirSync(repoDir, { recursive: true })
  const worktrees = Object.fromEntries(
    (ctx.SLUGS as string[]).map((slug: string) => [slug, path.join(argusHome, 'wt', slug)])
  )
  seedCases(ctx, { repos: { hmtDir: repoDir, syntheticDir: repoDir, worktrees } })
}

describe('re-seeding a case', () => {
  it('clears BOTH evidence index generations, and does not need the legacy pair to exist', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-seed-idx-'))
    db = openDb(path.join(tmp, 'argus.db'))
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE name = 'evidence_fts_map'`).get()
    ).toBeUndefined()

    seedOnce(tmp, db)

    // Stand in for the Rescan the workflow tells you to click: evidence rows plus their
    // contentless index entries.
    const caseId = (
      db.prepare(`SELECT id FROM cases WHERE slug = ?`).get('HMT-1-burst-token') as {
        id: number
      }
    ).id
    const evidenceId = Number(
      db
        .prepare(
          `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, created_at)
           VALUES (?, 'evidence/app.log', 'h', 'log', 1, '')`
        )
        .run(caseId).lastInsertRowid
    )
    indexEvidenceText(db, evidenceId, 'rescanned evidence text\n', 400)
    expect(
      (db.prepare(`SELECT count(*) AS n FROM evidence_index_map`).get() as { n: number }).n
    ).toBe(1)

    // Re-seed. This must not throw over the missing legacy tables...
    expect(() => seedOnce(tmp, db!)).not.toThrow()

    // ...and must leave no index row, and no map row, for the cascade-deleted evidence.
    expect(
      (db.prepare(`SELECT count(*) AS n FROM evidence_index_map`).get() as { n: number }).n
    ).toBe(0)
    expect((db.prepare(`SELECT count(*) AS n FROM evidence_index`).get() as { n: number }).n).toBe(
      0
    )
    expect(
      (
        db.prepare(`SELECT count(*) AS n FROM evidence WHERE id = ?`).get(evidenceId) as {
          n: number
        }
      ).n
    ).toBe(0)
  })
})
