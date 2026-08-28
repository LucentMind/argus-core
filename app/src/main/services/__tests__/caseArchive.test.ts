import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { archiveCase } from '../caseArchive'
import { caseArchivePath, caseDir } from '../paths'
import { getCase } from '../caseService'
import { searchEvidence } from '../search'
import { cleanupArchiveFixtures, seedArchivableCase, snapshotCase } from './archiveFixtures'

afterEach(() => {
  cleanupArchiveFixtures()
})

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

    await archiveCase(db, home, slug, { argusVersion: 'test' })

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
