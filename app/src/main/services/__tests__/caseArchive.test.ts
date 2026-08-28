import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { archiveCase, manifestHash } from '../caseArchive'
import { freezeCase, isCaseFrozen } from '../caseFreeze'
import { verifyBundleArchive } from '../bundle'
import { ingestArtifact, listEvidence } from '../ingest'
import { extractDerivedText } from '../extraction'
import type { Extractors } from '../packs/extractors'
import { createImmediateQueue } from '../ingestQueue'
import { createDetection } from '../packs/detection'
import { caseArchivePath, caseDir } from '../paths'
import { getCase } from '../caseService'
import { searchEvidence } from '../search'
import { scanEvidence } from '../scan'
import { createSession, listSessions } from '../agent/sessionStore'
import { SessionMirror } from '../agent/mirror'
import { readReportMarkdown } from '../rca/artifacts'
import { assembleDistillInput } from '../distill/input'
import type { BundleManifest } from '../../../shared/bundle'
import { cleanupArchiveFixtures, seedArchivableCase, snapshotCase } from './archiveFixtures'
import { createLegacyEvidenceFts } from './legacyFts'

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

    // The LEGACY generation too. `deleteEvidenceFtsForCase` clears both, and on a database
    // that has not finished the contentless migration the legacy pair is where an archived
    // case's chunks actually live — a mutation dropping only that branch would otherwise pass.
    // openDb no longer declares these tables, so the fixture recreates the pre-migration
    // schema exactly as an older release left it (createLegacyEvidenceFts is the frozen copy
    // of that column list, already used by the migration tests).
    createLegacyEvidenceFts(db)
    const legacyRowid = Number(
      db
        .prepare(
          `INSERT INTO evidence_fts (content, evidence_id, chunk_index, start_line, end_line)
           VALUES ('the needle in the legacy index', ?, 0, 1, 2)`
        )
        .run(evidenceIds[0]).lastInsertRowid
    )
    db.prepare(`INSERT INTO evidence_fts_map (fts_rowid, evidence_id) VALUES (?, ?)`).run(
      legacyRowid,
      evidenceIds[0]
    )

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
    const legacyMapLeft = Number(
      (
        db
          .prepare(`SELECT count(*) AS n FROM evidence_fts_map WHERE evidence_id IN (${idList})`)
          .get() as { n: number }
      ).n
    )
    expect(legacyMapLeft, 'orphaned evidence_fts_map rows').toBe(0)
    const legacyLeft = Number(
      (
        db.prepare(`SELECT count(*) AS n FROM evidence_fts WHERE rowid = ?`).get(legacyRowid) as {
          n: number
        }
      ).n
    )
    expect(legacyLeft, 'orphaned evidence_fts rows').toBe(0)

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

    const freeze = freezeCase(slug)
    try {
      await expect(run()).rejects.toThrow(/being archived/i)
    } finally {
      freeze.release()
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

describe('the freeze is owner-scoped and non-reentrant', () => {
  it('refuses a second, overlapping archive and keeps the FIRST one frozen', async () => {
    const { db, home, slug } = await seedArchivableCase()
    let before: unknown = null
    let after: unknown = null
    let second: unknown = null
    let stillFrozen = false

    const res = await archiveCase(
      db,
      home,
      slug,
      { argusVersion: 'test' },
      {
        // inside the first archive's verify window: bundle sealed, nothing deleted yet
        verify: async (zip): Promise<BundleManifest> => {
          before = snapshotCase(db, home, slug)
          second = await archiveCase(db, home, slug, { argusVersion: 'test' }).then(
            () => null,
            (e) => e
          )
          // the refused attempt's `finally` must NOT have released the freeze this archive
          // is still relying on — that release is what reopened the write window
          stillFrozen = isCaseFrozen(slug)
          after = snapshotCase(db, home, slug)
          return await verifyBundleArchive(zip)
        }
      }
    )

    expect(String(second)).toMatch(/already being archived/i)
    expect(stillFrozen, 'the first archive lost its freeze to the refused one').toBe(true)
    expect(after, 'the refused attempt changed the case').toEqual(before)
    expect(fs.existsSync(res.bundlePath)).toBe(true)
    expect(isCaseFrozen(slug)).toBe(false)
  })

  it('a stale handle cannot release a later freeze of the same slug', () => {
    const first = freezeCase('FREEZE-OWNER-1')
    expect(() => freezeCase('FREEZE-OWNER-1')).toThrow(/already being archived/i)
    first.release()

    const second = freezeCase('FREEZE-OWNER-1')
    first.release() // the previous owner's handle: must be inert now
    expect(isCaseFrozen('FREEZE-OWNER-1'), 'a stale handle released someone else’s freeze').toBe(
      true
    )
    second.release()
    expect(isCaseFrozen('FREEZE-OWNER-1')).toBe(false)
  })
})

describe('scanEvidence is a write path too, and obeys the freeze', () => {
  const scanDeps = (
    db: Parameters<typeof scanEvidence>[0],
    home: string
  ): Parameters<typeof scanEvidence>[3] => ({
    evidenceChanged: () => {},
    queue: createImmediateQueue(db, home)
  })

  /** Drop an untracked file into the case's evidence dir — what Rescan exists to register. */
  function plantUntracked(home: string, slug: string, name: string): string {
    const dest = path.join(caseDir(home, slug), 'evidence', name)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, 'dropped in by hand while the archive was running\n')
    return dest
  }

  it('a scan into a FROZEN case throws and registers nothing', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const planted = plantUntracked(home, slug, 'rescan-me.log')
    const rowsBefore = evidenceCount(db, slug)

    const freeze = freezeCase(slug)
    try {
      expect(() => scanEvidence(db, home, createDetection(), scanDeps(db, home), slug)).toThrow(
        /being archived/i
      )
    } finally {
      freeze.release()
    }

    // the file is still just a file: no row, and no .meta sidecar written for it
    expect(evidenceCount(db, slug)).toBe(rowsBefore)
    // .meta/ itself pre-exists (the fixture's own ingests wrote sidecars there); what must
    // not exist is a sidecar for THIS file, which is what registering it would create
    expect(
      fs.existsSync(path.join(caseDir(home, slug), 'evidence', '.meta', 'rescan-me.log.json'))
    ).toBe(false)
    expect(fs.existsSync(planted), 'the scan must not have touched the file itself').toBe(true)
  })

  it('a scan into an ARCHIVED case throws and does not recreate the deleted tree', async () => {
    const { db, home, slug } = await seedArchivableCase()
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    const evidenceRoot = path.join(caseDir(home, slug), 'evidence')
    expect(fs.existsSync(evidenceRoot)).toBe(false)

    expect(() => scanEvidence(db, home, createDetection(), scanDeps(db, home), slug)).toThrow(
      /archived/i
    )

    // the guard sits before scanEvidence's own mkdirSync: an archived case must not get its
    // evidence/ directory back as a side effect of someone pressing Rescan
    expect(fs.existsSync(evidenceRoot), 'evidence/ was recreated').toBe(false)
    expect(evidenceCount(db, slug)).toBe(0)
  })

  it('a scan into an ordinary live case still registers the file', async () => {
    const { db, home, slug } = await seedArchivableCase()
    plantUntracked(home, slug, 'ordinary-rescan.log')
    const rowsBefore = evidenceCount(db, slug)

    const summary = scanEvidence(db, home, createDetection(), scanDeps(db, home), slug)

    expect(summary.added).toContain('evidence/ordinary-rescan.log')
    expect(evidenceCount(db, slug)).toBe(rowsBefore + 1)
  })
})

describe('extraction does not write into a frozen tree before its guard fires', () => {
  it('leaves no orphan .derived file when the case is frozen', async () => {
    const { db, home, slug } = await seedArchivableCase()
    // an evidence-scoped row specifically: the derived dir follows its parent's tree, so
    // picking whichever row came first would point this assertion at artifacts/.derived
    const rec = listEvidence(db, slug, 'all').find((e) => e.relPath.startsWith('evidence/'))!
    expect(rec).toBeTruthy()
    const derivedDir = path.join(caseDir(home, slug), 'evidence', '.derived')
    expect(fs.existsSync(derivedDir)).toBe(false)
    // the guard must fire before the extractor is ever run, so this command is never spawned
    const extractors = {
      extractFor: () => ({ command: 'no-such-extractor', args: ['{input}', '{output}'] })
    } as unknown as Extractors

    const freeze = freezeCase(slug)
    try {
      await expect(
        extractDerivedText(db, home, createImmediateQueue(db, home), rec, extractors)
      ).rejects.toThrow(/being archived/i)
    } finally {
      freeze.release()
    }

    // ingestDerived's guard alone fires only after the output file is on disk; this asserts
    // the directory the extraction pipeline creates was never made at all
    expect(fs.existsSync(derivedDir), 'an orphan .derived dir was created in a frozen tree').toBe(
      false
    )
  })
})

describe('a frozen or archived case cannot acquire a transcript writer', () => {
  it('createSession is refused for a frozen case and inserts no row', async () => {
    const { db, slug } = await seedArchivableCase()
    const caseId = getCase(db, slug)!.id
    const sessionsBefore = (
      db.prepare(`SELECT count(*) AS n FROM sessions WHERE case_id = ?`).get(caseId) as {
        n: number
      }
    ).n

    const freeze = freezeCase(slug)
    try {
      // exactly the call RoutinesService makes for an unattended background run
      // (routines/service.ts) — the session the scheduler can start on a timer at any point
      // inside the archive window, which never enters AgentService's live map
      expect(() =>
        createSession(db, slug, { driverKind: 'claude-agent-sdk', model: null })
      ).toThrow(/being archived/i)
    } finally {
      freeze.release()
    }

    const sessionsAfter = (
      db.prepare(`SELECT count(*) AS n FROM sessions WHERE case_id = ?`).get(caseId) as {
        n: number
      }
    ).n
    expect(sessionsAfter).toBe(sessionsBefore)
  })

  it('createSession is refused for an archived case and inserts no row', async () => {
    const { db, home, slug } = await seedArchivableCase()
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    const caseId = getCase(db, slug)!.id

    expect(() => createSession(db, slug, 'claude-agent-sdk')).toThrow(/archived/i)
    const n = (
      db.prepare(`SELECT count(*) AS n FROM sessions WHERE case_id = ?`).get(caseId) as {
        n: number
      }
    ).n
    expect(n).toBe(0)
  })

  it('a mirror cannot be constructed for a frozen case, so no transcript is appended', async () => {
    const { db, home, slug } = await seedArchivableCase()
    // an EXISTING session being resumed mid-archive: no new sessions row is created, so the
    // createSession guard above cannot see this at all
    const existing = Number(
      (
        db
          .prepare(`SELECT id FROM sessions WHERE case_id = (SELECT id FROM cases WHERE slug = ?)`)
          .get(slug) as { id: number }
      ).id
    )
    const file = path.join(caseDir(home, slug), 'sessions', `${existing + 100}.jsonl`)

    const freeze = freezeCase(slug)
    try {
      expect(
        () =>
          new SessionMirror(db, file, {
            caseId: getCase(db, slug)!.id,
            sessionId: existing + 100,
            caseSlug: slug
          })
      ).toThrow(/being archived/i)
    } finally {
      freeze.release()
    }
    // Nothing is asserted about `file` on purpose: the constructor only mkdirSyncs the
    // transcript's PARENT directory, which the fixture already created, so "the file does not
    // exist" would hold with or without the guard. The `toThrow` above is the whole assertion
    // here; the directory-creation seam is covered by the archived sibling test below, where
    // sessions/ really is gone.
  })

  it('a mirror cannot be constructed for an archived case, and does not recreate sessions/', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const caseId = getCase(db, slug)!.id
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    const sessionsDir = path.join(caseDir(home, slug), 'sessions')
    expect(fs.existsSync(sessionsDir)).toBe(false)

    expect(
      () =>
        new SessionMirror(db, path.join(sessionsDir, '7.jsonl'), {
          caseId,
          sessionId: 7,
          caseSlug: slug
        })
    ).toThrow(/archived/i)

    // the constructor's mkdirSync is what would otherwise resurrect the deleted tree
    expect(fs.existsSync(sessionsDir), 'sessions/ was recreated by the mirror').toBe(false)
  })
})

describe('the RCA report survives archiving', () => {
  // Owner decision: the RCA report files are knowledge, not bulk — the same category as
  // findings and case_summaries, which already survive. They stay on disk so an archived case
  // still renders its RCA, and they are STILL sealed in the bundle: a bundle missing them
  // would be a lossy archive.
  const RCA_FILES: Array<[string, string]> = [
    ['rca-structure.json', '{"rootCause":{"statement":"the cache key omitted the tenant id"}}'],
    ['rca-exec.md', '# exec report'],
    ['rca-tech.md', '# tech report']
  ]

  it('keeps the three report files on disk, seals them in the bundle, and still removes the bulk artifact', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const artifacts = path.join(caseDir(home, slug), 'artifacts')
    for (const [name, body] of RCA_FILES) fs.writeFileSync(path.join(artifacts, name), body)
    // the fixture's review artifact — bulk, and the thing that must still leave
    const bulk = path.join(artifacts, 'ci-verify.log')
    expect(fs.existsSync(bulk), 'fixture bulk artifact').toBe(true)

    const res = await archiveCase(db, home, slug, { argusVersion: 'test' })

    // still on disk, byte for byte, and readable through the same functions the case view uses
    for (const [name, body] of RCA_FILES) {
      expect(fs.readFileSync(path.join(artifacts, name), 'utf8'), name).toBe(body)
    }
    expect(readReportMarkdown(home, slug)).toEqual({
      exec: '# exec report',
      tech: '# tech report'
    })

    // and sealed in the bundle all the same
    const manifest = await verifyBundleArchive(res.bundlePath)
    const inBundle = manifest.files.map((f) => f.path)
    for (const [name] of RCA_FILES) expect(inBundle, name).toContain(`artifacts/${name}`)

    // the bulk artifact left disk, and its only copy is the bundle
    expect(fs.existsSync(bulk), 'bulk artifact still on disk').toBe(false)
    expect(inBundle).toContain('artifacts/ci-verify.log')
  })

  it('removes artifacts/ entirely when the case has no RCA report', async () => {
    // the pre-existing behaviour, unchanged: nothing kept → the directory itself goes
    const { db, home, slug } = await seedArchivableCase()
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    expect(fs.existsSync(path.join(caseDir(home, slug), 'artifacts'))).toBe(false)
  })

  it('bytesFreed counts only what actually left', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const artifacts = path.join(caseDir(home, slug), 'artifacts')
    const kept = 'x'.repeat(5000)
    fs.writeFileSync(path.join(artifacts, 'rca-exec.md'), kept)
    fs.writeFileSync(path.join(artifacts, 'rca-tech.md'), kept)
    fs.writeFileSync(path.join(artifacts, 'rca-structure.json'), kept)

    const res = await archiveCase(db, home, slug, { argusVersion: 'test' })
    // a blanket dirBytes over artifacts/ would have counted the 15000 kept bytes as freed
    expect(res.bytesFreed).toBeLessThan(15000)
    expect(res.bytesFreed).toBeGreaterThan(0)
  })
})

describe('listSessions on an archived case', () => {
  // Archiving deletes every sessions row, and createSession refuses an archived case, so
  // listSessions' auto-create turned every read into a throw: the case view's chat pane and
  // assembleDistillInput (distilling an archived case is a first-class workflow) both failed.
  it('returns [] and creates no row', async () => {
    const { db, home, slug } = await seedArchivableCase()
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    const caseId = getCase(db, slug)!.id

    expect(listSessions(db, slug)).toEqual([])

    const n = (
      db.prepare(`SELECT count(*) AS n FROM sessions WHERE case_id = ?`).get(caseId) as {
        n: number
      }
    ).n
    expect(n, 'a session was created for an archived case').toBe(0)
  })

  it('lets assembleDistillInput run on an archived case — the symptom that found this', async () => {
    // distill_jobs and case_summaries deliberately survive archiving, so distilling an
    // archived case is a first-class workflow. It threw here before, from listSessions.
    const { db, home, slug } = await seedArchivableCase()
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    expect(assembleDistillInput(db, home, slug).sessionTitles).toEqual([])
  })

  it('still auto-creates on an ordinary live case with zero sessions', async () => {
    const { db, slug } = await seedArchivableCase()
    const caseId = getCase(db, slug)!.id
    db.prepare(`DELETE FROM sessions WHERE case_id = ?`).run(caseId)

    const sessions = listSessions(db, slug)
    expect(sessions).toHaveLength(1)
    const n = (
      db.prepare(`SELECT count(*) AS n FROM sessions WHERE case_id = ?`).get(caseId) as {
        n: number
      }
    ).n
    expect(n).toBe(1)
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
