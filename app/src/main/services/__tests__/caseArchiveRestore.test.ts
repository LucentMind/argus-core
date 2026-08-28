import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { Zip, extract } from 'zip-lib'
import { archiveCase, restoreCase } from '../caseArchive'
import { createCase, getCase } from '../caseService'
import { ingestArtifact, sha256File } from '../ingest'
import { createDetection } from '../packs/detection'
import { createImmediateQueue } from '../ingestQueue'
import { caseArchivePath, caseDir } from '../paths'
import { searchEvidence } from '../search'
import { isCaseFrozen } from '../caseFreeze'
import { readReportMarkdown } from '../rca/artifacts'
import { cleanupArchiveFixtures, seedArchivableCase } from './archiveFixtures'

afterEach(() => {
  cleanupArchiveFixtures()
})

/**
 * Content, not counts: every evidence row's rel path with BOTH the sha256 the row claims and
 * the sha256 of the file actually on disk, plus every transcript event. Row counts match
 * trivially when the files are empty or missing, which is exactly the half-restore this is
 * here to catch.
 *
 * The three envelope identity fields are stripped from each event on purpose: restore rebuilds
 * the `sessions` rows the archive deleted, so a transcript comes back under a NEW session id
 * and its envelopes are rewritten to it. The id is the one thing legitimately allowed to
 * change; the event bodies are not.
 */
function contentSnapshot(
  db: DatabaseSync,
  home: string,
  slug: string
): { evidence: string[]; transcripts: string[] } {
  const caseId = getCase(db, slug)!.id
  const dir = caseDir(home, slug)
  const evidence = (
    db
      .prepare(`SELECT rel_path, sha256 FROM evidence WHERE case_id = ?`)
      .all(caseId) as unknown as {
      rel_path: string
      sha256: string
    }[]
  )
    .map((r) => {
      const abs = path.join(dir, ...r.rel_path.split('/'))
      return `${r.rel_path}:${r.sha256}:${fs.existsSync(abs) ? sha256File(abs) : 'FILE-MISSING'}`
    })
    .sort()
  const sessionsDir = path.join(dir, 'sessions')
  const transcripts = (fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [])
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(sessionsDir, f), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
    )
    .map((line) => {
      const e = JSON.parse(line) as Record<string, unknown>
      delete e.caseId
      delete e.caseSlug
      delete e.sessionId
      return JSON.stringify(e)
    })
    .sort()
  return { evidence, transcripts }
}

/** Rewrite one entry's bytes inside a built bundle, leaving manifest.json (and therefore the
 *  recorded hash of that entry) untouched — a bundle that no longer matches itself. */
async function tamperWithZipEntry(zipPath: string, entryName: string, body: string): Promise<void> {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-tamper-')))
  try {
    await extract(zipPath, tmp, { safeSymlinksOnly: true })
    const target = path.join(tmp, ...entryName.split('/'))
    if (!fs.existsSync(target)) throw new Error(`tamper target not in bundle: ${entryName}`)
    fs.writeFileSync(target, body)
    const zip = new Zip()
    const walk = (rel: string): void => {
      const abs = rel ? path.join(tmp, ...rel.split('/')) : tmp
      for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${ent.name}` : ent.name
        if (ent.isDirectory()) walk(childRel)
        else zip.addFile(path.join(abs, ent.name), childRel)
      }
    }
    walk('')
    fs.rmSync(zipPath)
    await zip.archive(zipPath)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

describe('restoreCase', () => {
  it('round-trips a case by content, not by count', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const before = contentSnapshot(db, home, slug)
    expect(before.evidence).toHaveLength(2)
    expect(before.transcripts).toHaveLength(1)
    await archiveCase(db, home, slug, { argusVersion: 'test' })

    const res = await restoreCase(db, home, slug, createImmediateQueue(db, home))

    expect(contentSnapshot(db, home, slug)).toEqual(before)
    expect(res.slug).toBe(slug)
    expect(res.evidenceRestored).toBe(2)
    expect(res.sessionsRestored).toBe(1)
    // and the freeze restore takes for the duration is released
    expect(isCaseFrozen(slug)).toBe(false)
  })

  it('makes the evidence searchable again', async () => {
    const { db, home, slug } = await seedArchivableCase()
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    expect(searchEvidence(db, home, 'needle', { caseSlug: slug })).toEqual([])

    await restoreCase(db, home, slug, createImmediateQueue(db, home))

    const hits = searchEvidence(db, home, 'needle', { caseSlug: slug })
    expect(hits).toHaveLength(1)
    expect(hits[0].snippet).toContain('«needle»')
  })

  it('clears the archived flag and leaves no second case', async () => {
    const { db, home, slug } = await seedArchivableCase()
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    const idBefore = getCase(db, slug)!.id

    await restoreCase(db, home, slug, createImmediateQueue(db, home))

    const rec = getCase(db, slug)!
    expect(rec.archivedAt).toBeNull()
    expect(rec.archivePath).toBeNull()
    // restore is NOT import: importCase would have created a second case through proposeSlug
    expect(rec.id).toBe(idBefore)
    const n = (db.prepare(`SELECT count(*) AS n FROM cases`).get() as { n: number }).n
    expect(n).toBe(1)
    const digest = db.prepare(`SELECT archive_sha256 AS h FROM cases WHERE id = ?`).get(rec.id) as {
      h: string | null
    }
    expect(digest.h).toBeNull()
  })

  it('keeps the knowledge layer, which never left', async () => {
    const { db, home, slug } = await seedArchivableCase()
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    await restoreCase(db, home, slug, createImmediateQueue(db, home))

    const caseId = getCase(db, slug)!.id
    const findings = (
      db.prepare(`SELECT count(*) AS n FROM findings WHERE case_id = ?`).get(caseId) as {
        n: number
      }
    ).n
    expect(findings).toBeGreaterThan(0)
    const summaries = (
      db.prepare(`SELECT count(*) AS n FROM case_summaries WHERE case_slug = ?`).get(slug) as {
        n: number
      }
    ).n
    expect(summaries).toBe(1)
  })

  it('refuses a case that is not archived', async () => {
    const { db, home, slug } = await seedArchivableCase()
    await expect(restoreCase(db, home, slug, createImmediateQueue(db, home))).rejects.toThrow(
      /not archived/i
    )
  })

  it('refuses when the bundle is missing from disk, without touching the case', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const res = await archiveCase(db, home, slug, { argusVersion: 'test' })
    fs.rmSync(res.bundlePath)
    await expect(restoreCase(db, home, slug, createImmediateQueue(db, home))).rejects.toThrow(
      /archive is missing from disk/i
    )
    expect(getCase(db, slug)!.archivedAt).not.toBeNull()
    expect(fs.existsSync(path.join(caseDir(home, slug), 'evidence'))).toBe(false)
    expect(isCaseFrozen(slug)).toBe(false)
  })

  it('refuses a bundle whose contents no longer match, without touching the case', async () => {
    const { db, home, slug } = await seedArchivableCase()
    const res = await archiveCase(db, home, slug, { argusVersion: 'test' })
    await tamperWithZipEntry(res.bundlePath, 'case/evidence/sample.log', 'swapped\n')
    await expect(restoreCase(db, home, slug, createImmediateQueue(db, home))).rejects.toThrow(
      /Bundle is corrupt: checksum mismatch on evidence\/sample\.log/
    )
    expect(getCase(db, slug)!.archivedAt).not.toBeNull()
    expect(fs.existsSync(path.join(caseDir(home, slug), 'evidence'))).toBe(false)
    expect(
      (db.prepare(`SELECT count(*) AS n FROM evidence`).get() as { n: number }).n,
      'tampered content was reindexed'
    ).toBe(0)
  })

  it('refuses a VALID bundle that belongs to a different case', async () => {
    // Integrity is not identity. verifyBundleArchive passes on this bundle — it is internally
    // consistent — but it is another case's bundle renamed into this case's archive path, and
    // restoring it would silently graft one case's evidence onto another.
    const { db, home, slug } = await seedArchivableCase()
    createCase(db, home, { slug: 'OTHER-9', title: 'someone else' })
    // the foreign bundle carries real evidence of its own, so "nothing was grafted on" below
    // is a claim about content rather than about an empty bundle having nothing to give
    const foreign = path.join(home, 'their-secret.log')
    fs.writeFileSync(foreign, 'another case’s confidential log\n')
    await ingestArtifact(
      db,
      home,
      createDetection(),
      createImmediateQueue(db, home),
      'OTHER-9',
      foreign
    )
    const other = await archiveCase(db, home, 'OTHER-9', { argusVersion: 'test' })
    const mine = await archiveCase(db, home, slug, { argusVersion: 'test' })
    fs.copyFileSync(other.bundlePath, mine.bundlePath)

    await expect(restoreCase(db, home, slug, createImmediateQueue(db, home))).rejects.toThrow(
      /does not belong to this case/i
    )

    expect(getCase(db, slug)!.archivedAt).not.toBeNull()
    expect(getCase(db, slug)!.archivePath).toBe(caseArchivePath(home, slug))
    expect(fs.existsSync(path.join(caseDir(home, slug), 'evidence'))).toBe(false)
    expect(
      fs.existsSync(path.join(caseDir(home, slug), 'evidence', 'their-secret.log')),
      'another case’s file was written into this case'
    ).toBe(false)
    expect(
      (db.prepare(`SELECT count(*) AS n FROM evidence`).get() as { n: number }).n,
      'another case’s evidence was grafted on'
    ).toBe(0)
    expect(isCaseFrozen(slug)).toBe(false)
  })

  it('refuses a second, overlapping restore of the same case', async () => {
    // Restore holds the same freeze archiveCase does, for the whole operation. Without it two
    // restores of one slug would both extract into the same tree and both rebuild the evidence
    // and session rows, leaving the case with a duplicate of every row it owns.
    const { db, home, slug } = await seedArchivableCase()
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    let second: unknown = null
    let frozenDuringRestore = false

    await restoreCase(db, home, slug, createImmediateQueue(db, home), {
      afterExtract: async () => {
        frozenDuringRestore = isCaseFrozen(slug)
        second = await restoreCase(db, home, slug, createImmediateQueue(db, home)).then(
          () => null,
          (e) => e
        )
      }
    })

    expect(frozenDuringRestore, 'restore did not freeze the case').toBe(true)
    expect(String(second)).toMatch(/already being archived/i)
    // and the overlapping attempt duplicated nothing
    const caseId = getCase(db, slug)!.id
    const evidence = (
      db.prepare(`SELECT count(*) AS n FROM evidence WHERE case_id = ?`).get(caseId) as {
        n: number
      }
    ).n
    expect(evidence).toBe(2)
    const sessions = (
      db.prepare(`SELECT count(*) AS n FROM sessions WHERE case_id = ?`).get(caseId) as {
        n: number
      }
    ).n
    expect(sessions).toBe(1)
    expect(isCaseFrozen(slug)).toBe(false)
  })

  it('merges artifacts/ back around the RCA report that never left', async () => {
    // artifacts/ is the one tree archiving only partially removes: the three RCA report files
    // stay on disk so an archived case still renders its RCA. The directory is therefore
    // present and NON-EMPTY at restore time, so a plain rename of the bundle's copy would
    // throw ENOTEMPTY and silently skip the whole tree.
    const { db, home, slug } = await seedArchivableCase()
    const artifacts = path.join(caseDir(home, slug), 'artifacts')
    const rca: Array<[string, string]> = [
      ['rca-structure.json', '{"rootCause":{"statement":"the cache key omitted the tenant id"}}'],
      ['rca-exec.md', '# exec report'],
      ['rca-tech.md', '# tech report']
    ]
    for (const [name, body] of rca) fs.writeFileSync(path.join(artifacts, name), body)

    const before = contentSnapshot(db, home, slug)
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    // precondition: the report survived the archive, so the directory is in the way
    expect(fs.existsSync(path.join(artifacts, 'rca-exec.md'))).toBe(true)
    expect(fs.existsSync(path.join(artifacts, 'ci-verify.log'))).toBe(false)
    expect(fs.existsSync(path.join(artifacts, '.meta'))).toBe(false)

    await restoreCase(db, home, slug, createImmediateQueue(db, home))

    // the bulk artifact and its sidecar came back...
    expect(fs.readFileSync(path.join(artifacts, 'ci-verify.log'), 'utf8')).toBe(
      'review artifact contents\n'
    )
    expect(fs.existsSync(path.join(artifacts, '.meta', 'ci-verify.log.json'))).toBe(true)
    // ...and the kept report is still exactly what it was
    for (const [name, body] of rca) {
      expect(fs.readFileSync(path.join(artifacts, name), 'utf8'), name).toBe(body)
    }
    expect(readReportMarkdown(home, slug)).toEqual({ exec: '# exec report', tech: '# tech report' })
    // the sidecar is what re-registers the artifact row; without it the file is unindexed
    expect(contentSnapshot(db, home, slug)).toEqual(before)
  })
})
