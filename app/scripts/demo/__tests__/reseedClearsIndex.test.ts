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
// @ts-expect-error -- plain .mjs fixture module, no types
import { buildAppLog } from '../evidence.mjs'

/**
 * The demo home's twin of scripts/seed/__tests__/reseedClearsIndex.test.ts. Same defect,
 * same shape: the pre-cascade cleanup cleared only the legacy evidence_fts pair, so a
 * re-seed stranded evidence_index rows plus map rows naming cascade-deleted evidence — and
 * the cleanup then had to survive db.ts no longer declaring that legacy pair at all.
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
  const { anchors } = buildAppLog()
  seedCases(ctx, {
    repos: { hmtDir: repoDir, syntheticDir: repoDir, worktrees },
    anchors
  })
}

describe('re-seeding a demo case', () => {
  it('clears BOTH evidence index generations, and does not need the legacy pair to exist', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-demo-idx-'))
    db = openDb(path.join(tmp, 'argus.db'))
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE name = 'evidence_fts_map'`).get()
    ).toBeUndefined()

    seedOnce(tmp, db)

    const slug = (db.prepare(`SELECT slug FROM cases LIMIT 1`).get() as { slug: string }).slug
    const caseId = (db.prepare(`SELECT id FROM cases WHERE slug = ?`).get(slug) as { id: number })
      .id
    const evidenceId = Number(
      db
        .prepare(
          `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, created_at)
           VALUES (?, 'evidence/app.log', 'h', 'log', 1, '')`
        )
        .run(caseId).lastInsertRowid
    )
    indexEvidenceText(db, evidenceId, 'rescanned demo evidence\n', 400)
    expect(
      (db.prepare(`SELECT count(*) AS n FROM evidence_index_map`).get() as { n: number }).n
    ).toBe(1)

    expect(() => seedOnce(tmp, db!)).not.toThrow()

    expect(
      (db.prepare(`SELECT count(*) AS n FROM evidence_index_map`).get() as { n: number }).n
    ).toBe(0)
    expect((db.prepare(`SELECT count(*) AS n FROM evidence_index`).get() as { n: number }).n).toBe(
      0
    )
  })
})
