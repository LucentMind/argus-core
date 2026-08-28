import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { archiveCase, manifestHash } from '../caseArchive'
import { freezeCase, isCaseFrozen, unfreezeCase } from '../caseFreeze'
import { verifyBundleArchive } from '../bundle'
import { ingestArtifact } from '../ingest'
import { createImmediateQueue } from '../ingestQueue'
import { createDetection } from '../packs/detection'
import { caseArchivePath, caseDir } from '../paths'
import { getCase } from '../caseService'
import { searchEvidence } from '../search'
import type { BundleManifest } from '../../../shared/bundle'
import { cleanupArchiveFixtures, seedArchivableCase, snapshotCase } from './archiveFixtures'

afterEach(() => {
  cleanupArchiveFixtures()
})

/** Write a file outside the case tree and try to ingest it as evidence. Returns the path it
 *  would have landed at, so a caller can assert nothing arrived there. */
async function tryIngest(
  db: Parameters<typeof ingestArtifact>[0],
  home: string,
  slug: string,
  name: string
): Promise<{ dest: string; run: () => Promise<unknown> }> {
  const src = path.join(home, name)
  fs.writeFileSync(src, 'arrived after the bundle was sealed\n')
  const dest = path.join(caseDir(home, slug), 'evidence', name)
  return {
    dest,
    run: () =>
      ingestArtifact(db, home, createDetection(), createImmediateQueue(db, home), slug, src)
  }
}

function evidenceCount(db: Parameters<typeof getCase>[0], slug: string): number {
  return Number(
    (
      db
        .prepare(
          `SELECT count(*) AS n FROM evidence WHERE case_id = (SELECT id FROM cases WHERE slug = ?)`
        )
        .get(slug) as { n: number }
    ).n
  )
}

describe('archiveCase', () => {
  it('writes a verified bundle and reports what it freed', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const res = await archiveCase(db, home, slug, { argusVersion: 'test' })

    expect(res.bundlePath).toBe(caseArchivePath(home, slug))
    expect(fs.existsSync(res.bundlePath)).toBe(true)
    expect(res.bytesFreed).toBeGreaterThan(0)
    expect(res.evidenceRemoved).toBe(2)
    expect(res.sessionsRemoved).toBe(1)
  })

  it('removes the evidence, artifacts and sessions trees but keeps the case dir', async () => {
    const { db, home, slug } = await seedArchivableCase()
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    const dir = caseDir(home, slug)
    expect(fs.existsSync(path.join(dir, 'evidence'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'artifacts'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'sessions'))).toBe(false)
    // the case itself still renders: its own record and any RCA/summary stay put
    expect(fs.existsSync(dir)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'summary.md'))).toBe(true)
  })

  it('clears the evidence rows and the search index', async () => {
    const { db, home, slug } = await seedArchivableCase()
    expect(searchEvidence(db, home, 'needle', { caseSlug: slug })).toHaveLength(1)

    // Captured BEFORE the archive: once the evidence rows are gone, searchEvidence returns []
    // because its join finds nothing, whether or not the index rows were cleared. Only the
    // ids taken up front can see an orphaned index row.
    const seedCaseId = getCase(db, slug)!.id
    const evidenceIds = (
      db.prepare(`SELECT id FROM evidence WHERE case_id = ?`).all(seedCaseId) as unknown as {
        id: number
      }[]
    ).map((r) => Number(r.id))
    expect(evidenceIds.length).toBeGreaterThan(0)
    const idList = evidenceIds.join(',')
    const indexRowids = (
      db
        .prepare(`SELECT fts_rowid FROM evidence_index_map WHERE evidence_id IN (${idList})`)
        .all() as unknown as { fts_rowid: number }[]
    ).map((r) => Number(r.fts_rowid))
    expect(indexRowids.length).toBeGreaterThan(0)

    await archiveCase(db, home, slug, { argusVersion: 'test' })

    // the index rows for those exact ids are gone, not merely unreachable through the join
    const mapLeft = Number(
      (
        db
          .prepare(`SELECT count(*) AS n FROM evidence_index_map WHERE evidence_id IN (${idList})`)
          .get() as { n: number }
      ).n
    )
    expect(mapLeft, 'orphaned evidence_index_map rows').toBe(0)
    const indexLeft = Number(
      (
        db
          .prepare(
            `SELECT count(*) AS n FROM evidence_index WHERE rowid IN (${indexRowids.join(',')})`
          )
          .get() as { n: number }
      ).n
    )
    expect(indexLeft, 'orphaned evidence_index rows').toBe(0)

    expect(searchEvidence(db, home, 'needle', { caseSlug: slug })).toEqual([])
    const caseId = getCase(db, slug)!.id
    for (const t of ['evidence', 'sessions', 'turns', 'tool_calls']) {
      const n = (
        db.prepare(`SELECT count(*) AS n FROM ${t} WHERE case_id = ?`).get(caseId) as { n: number }
      ).n
      expect(n, t).toBe(0)
    }
    // the chat index goes with the transcripts it pointed at
    const msgs = (
      db.prepare(`SELECT count(*) AS n FROM messages_fts_map WHERE case_id = ?`).get(caseId) as {
        n: number
      }
    ).n
    expect(msgs).toBe(0)
  })

  it('KEEPS the knowledge layer — this is the whole point of archiving', async () => {
    const { db, home, slug } = await seedArchivableCase()
    await archiveCase(db, home, slug, { argusVersion: 'test' })

    const rec = getCase(db, slug)
    expect(rec).toBeTruthy()
    expect(rec!.archivedAt).not.toBeNull()
    expect(rec!.archivePath).toBe(caseArchivePath(home, slug))

    const summaries = (
      db.prepare(`SELECT count(*) AS n FROM case_summaries WHERE case_slug = ?`).get(slug) as {
        n: number
      }
    ).n
    expect(summaries).toBe(1)
    const summaryFts = (
      db.prepare(`SELECT count(*) AS n FROM case_summaries_fts WHERE case_slug = ?`).get(slug) as {
        n: number
      }
    ).n
    expect(summaryFts).toBe(1)
    const findings = (
      db.prepare(`SELECT count(*) AS n FROM findings WHERE case_id = ?`).get(rec!.id) as {
        n: number
      }
    ).n
    expect(findings).toBeGreaterThan(0)
  })

  it('records the manifest digest so a restore can tell this bundle from another', async () => {
    const { db, home, slug } = await seedArchivableCase()
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    const row = db.prepare(`SELECT archive_sha256 AS h FROM cases WHERE slug = ?`).get(slug) as {
      h: string | null
    }
    expect(row.h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('nulls the finding pointers into deleted sessions rather than leaving them dangling', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const caseId = getCase(db, slug)!.id
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    const rows = db
      .prepare(`SELECT session_id, turn_id FROM findings WHERE case_id = ?`)
      .all(caseId) as unknown as { session_id: number | null; turn_id: number | null }[]
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.session_id).toBeNull()
      expect(r.turn_id).toBeNull()
    }
  })

  it('refuses a case that is already archived', async () => {
    const { db, home, slug } = await seedArchivableCase()
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    await expect(archiveCase(db, home, slug, { argusVersion: 'test' })).rejects.toThrow(
      /already archived/i
    )
  })

  it('refuses an unknown case', async () => {
    const { db, home } = await seedArchivableCase()
    await expect(archiveCase(db, home, 'NO-SUCH', { argusVersion: 'test' })).rejects.toThrow(
      /unknown case/i
    )
  })
})

describe('archiveCase refuses an unstable case and freezes a stable one', () => {
  it('refuses a case with live agent work and leaves it completely untouched', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const before = snapshotCase(db, home, slug)

    await expect(
      archiveCase(db, home, slug, { argusVersion: 'test' }, { hasLiveWork: () => true })
    ).rejects.toThrow(/agent session still running/i)

    expect(snapshotCase(db, home, slug)).toEqual(before)
    expect(fs.existsSync(caseArchivePath(home, slug))).toBe(false)
    expect(isCaseFrozen(slug)).toBe(false)
  })

  it('archives normally when the live-work seam reports the case is idle', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const res = await archiveCase(
      db,
      home,
      slug,
      { argusVersion: 'test' },
      { hasLiveWork: () => false }
    )
    expect(fs.existsSync(res.bundlePath)).toBe(true)
  })

  it('rejects an ingest that lands mid-archive, while the bundle is being verified', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const { dest, run } = await tryIngest(db, home, slug, 'late-arrival.log')
    let thrown: unknown = null
    let landedDuringWindow = true

    await archiveCase(
      db,
      home,
      slug,
      { argusVersion: 'test' },
      {
        // exactly the window the freeze exists for: the bundle is sealed, verification is
        // running, and the deletes have not happened yet
        verify: async (zip): Promise<BundleManifest> => {
          await run().catch((e) => {
            thrown = e
          })
          landedDuringWindow = fs.existsSync(dest)
          return await verifyBundleArchive(zip)
        }
      }
    )

    expect(String(thrown)).toMatch(/being archived/i)
    expect(landedDuringWindow, 'a file landed inside the archive window').toBe(false)
  })

  it('an ingest into a frozen case throws and writes nothing', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const { dest, run } = await tryIngest(db, home, slug, 'frozen.log')
    const rowsBefore = evidenceCount(db, slug)

    freezeCase(slug)
    try {
      await expect(run()).rejects.toThrow(/being archived/i)
    } finally {
      unfreezeCase(slug)
    }

    expect(fs.existsSync(dest), 'the file must not have landed').toBe(false)
    expect(evidenceCount(db, slug)).toBe(rowsBefore)
  })

  it('an ingest into an archived case throws', async () => {
    const { db, home, slug } = await seedArchivableCase()
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    const { dest, run } = await tryIngest(db, home, slug, 'after-archive.log')

    await expect(run()).rejects.toThrow(/archived/i)
    expect(fs.existsSync(dest)).toBe(false)
  })

  it('an ingest into an ordinary live case still works', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const { dest, run } = await tryIngest(db, home, slug, 'ordinary.log')
    const rowsBefore = evidenceCount(db, slug)

    await expect(run()).resolves.toBeTruthy()
    expect(fs.existsSync(dest)).toBe(true)
    expect(evidenceCount(db, slug)).toBe(rowsBefore + 1)
  })

  it('releases the freeze when the archive fails, so the case stays usable', async () => {
    const { db, home, slug } = await seedArchivableCase()
    await expect(
      archiveCase(
        db,
        home,
        slug,
        { argusVersion: 'test' },
        {
          verify: async () => {
            throw new Error('Bundle is corrupt: checksum mismatch')
          }
        }
      )
    ).rejects.toThrow(/checksum mismatch/)

    expect(isCaseFrozen(slug)).toBe(false)
    const { dest, run } = await tryIngest(db, home, slug, 'after-failed-archive.log')
    await expect(run()).resolves.toBeTruthy()
    expect(fs.existsSync(dest)).toBe(true)
  })
})

describe('archiveCase survives a post-commit tree-removal failure', () => {
  // On Windows an open handle makes rmSync throw EBUSY/EPERM. By that point the case is
  // genuinely archived — rows gone, archived_at stamped, bundle in place — so throwing would
  // report "archive failed" for an operation that succeeded, and the retry could only ever hit
  // "already archived", with no way forward.
  it('reports success when removing a tree fails after the commit', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const attempted: string[] = []

    const res = await archiveCase(
      db,
      home,
      slug,
      { argusVersion: 'test' },
      {
        removeTree: (p) => {
          attempted.push(path.basename(p))
          const err = new Error(`EBUSY: resource busy or locked, rmdir '${p}'`)
          throw err
        }
      }
    )

    expect(fs.existsSync(res.bundlePath)).toBe(true)
    expect(getCase(db, slug)!.archivedAt).not.toBeNull()
    // every tree was still attempted — one failure must not skip the rest
    expect(attempted).toEqual(['evidence', 'artifacts', 'sessions'])
  })
})

describe('manifestHash', () => {
  const files = [
    { path: 'case/evidence/a.log', sha256: 'a'.repeat(64), size: 1 },
    { path: 'case/evidence/b.log', sha256: 'b'.repeat(64), size: 2 }
  ]
  const manifest = (slug: string, order = files): BundleManifest =>
    ({
      format: 1,
      slug,
      title: 't',
      argusVersion: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
      includesTranscripts: true,
      workspaces: [],
      files: order
    }) as BundleManifest

  it('distinguishes two bundles with identical files but different slugs', () => {
    // without the slug in the digest this guarantee rests on two cases never having
    // byte-identical trees, which is a coincidence, not a check
    expect(manifestHash(manifest('KAN-1'))).not.toBe(manifestHash(manifest('KAN-2')))
  })

  it('is deterministic and order-independent', () => {
    expect(manifestHash(manifest('KAN-1'))).toBe(manifestHash(manifest('KAN-1')))
    expect(manifestHash(manifest('KAN-1'))).toBe(
      manifestHash(manifest('KAN-1', [...files].reverse()))
    )
  })
})

describe('archiveCase ordering: a failure before the delete step removes nothing', () => {
  it('leaves the case fully intact when bundle verification fails', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const before = snapshotCase(db, home, slug)

    await expect(
      archiveCase(
        db,
        home,
        slug,
        { argusVersion: 'test' },
        {
          verify: async () => {
            throw new Error('Bundle is corrupt: checksum mismatch on case/evidence/sample.log')
          }
        }
      )
    ).rejects.toThrow(/checksum mismatch/)

    expect(snapshotCase(db, home, slug)).toEqual(before)
    expect(fs.existsSync(caseArchivePath(home, slug))).toBe(false)
  })

  it('leaves the case fully intact when writing the bundle fails', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const before = snapshotCase(db, home, slug)

    await expect(
      archiveCase(
        db,
        home,
        slug,
        { argusVersion: 'test' },
        {
          exportTo: async () => {
            throw new Error('disk full')
          }
        }
      )
    ).rejects.toThrow(/disk full/)

    expect(snapshotCase(db, home, slug)).toEqual(before)
    expect(fs.existsSync(caseArchivePath(home, slug))).toBe(false)
  })
})
