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
import { searchMessages } from '../chatSearch'
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
): { evidence: string[]; transcripts: string[]; rows: Record<string, string[]> } {
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
  return { evidence, transcripts, rows: rowSnapshot(db, slug) }
}

/**
 * The rows that exist ONLY in the database: `turns`, `tool_calls`, and every finding's
 * session/turn pointer. Without these the round-trip assertion was blind to the loss it is
 * supposed to prevent — the bundle used to carry no rows at all, so an archive/restore cycle
 * silently took `turns` 1 → 0, `tool_calls` 1 → 0 and left the findings' deep-links null, and
 * an evidence-and-transcripts snapshot matched anyway.
 *
 * Session and turn ids legitimately change (restore rebuilds the deleted rows), so each id is
 * replaced by its ORDINAL among that case's rows. That is blind to id churn and to nothing
 * else: a row that did not come back has no ordinal, and a pointer that came back null reads
 * as `none`.
 */
function rowSnapshot(db: DatabaseSync, slug: string): Record<string, string[]> {
  const caseId = getCase(db, slug)!.id
  const ids = (sql: string): number[] =>
    (db.prepare(sql).all(caseId) as unknown as { id: number }[]).map((r) => Number(r.id))
  const sessions = ids(`SELECT id FROM sessions WHERE case_id = ? ORDER BY id`)
  const turnIds = ids(`SELECT id FROM turns WHERE case_id = ? ORDER BY id`)
  const key = (order: number[], prefix: string, id: unknown): string => {
    if (id == null) return 'none'
    const i = order.indexOf(Number(id))
    return i < 0 ? `DANGLING(${String(id)})` : `${prefix}${i}`
  }
  const all = <T>(sql: string): T[] => db.prepare(sql).all(caseId) as unknown as T[]
  return {
    turns: all<{ session_id: number; turn_index: number; status: string; created_at: string }>(
      `SELECT session_id, turn_index, status, created_at FROM turns WHERE case_id = ? ORDER BY id`
    ).map(
      (t) => `${key(sessions, 's', t.session_id)}/#${t.turn_index}:${t.status}:${t.created_at}`
    ),
    toolCalls: all<{
      session_id: number
      turn_id: number | null
      tool: string
      args_hash: string
      risk: string
      decision: string
      created_at: string
    }>(
      `SELECT session_id, turn_id, tool, args_hash, risk, decision, created_at
       FROM tool_calls WHERE case_id = ? ORDER BY id`
    ).map(
      (c) =>
        `${key(sessions, 's', c.session_id)}/${key(turnIds, 't', c.turn_id)}:${c.tool}:${c.args_hash}:${c.risk}:${c.decision}:${c.created_at}`
    ),
    findingPointers: all<{ summary: string; session_id: number | null; turn_id: number | null }>(
      `SELECT summary, session_id, turn_id FROM findings WHERE case_id = ? ORDER BY id`
    ).map((f) => `${f.summary}→${key(sessions, 's', f.session_id)}/${key(turnIds, 't', f.turn_id)}`)
  }
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
    expect(before.transcripts).toHaveLength(2)
    // the snapshot really is watching the database-only rows, not just files
    expect(before.rows.turns).toHaveLength(1)
    expect(before.rows.toolCalls).toHaveLength(1)
    expect(before.rows.findingPointers).toEqual(['a reviewed conclusion→s0/t0'])
    await archiveCase(db, home, slug, { argusVersion: 'test' })

    const res = await restoreCase(db, home, slug, createImmediateQueue(db, home))

    expect(contentSnapshot(db, home, slug)).toEqual(before)
    expect(res.slug).toBe(slug)
    expect(res.evidenceRestored).toBe(2)
    expect(res.sessionsRestored).toBe(1)
    // Every restored row was indexed inline by the rebuild, so nothing is left at 'pending'
    // for the boot sweep to re-queue. It used to re-queue all of them — the .meta sidecars
    // carry the ingest-time 'pending' and were never rewritten — which under the production
    // queue re-runs the extractor over every restored file.
    expect(res.queuedForIndex, 'restored rows were re-queued for indexing').toBe(0)
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
    // NOTE: no isCaseFrozen assertion here on purpose — this path throws before freezeCase is
    // ever called, so the assertion could not fail whatever the code did. The identical
    // assertion in the foreign-bundle test below IS meaningful: the freeze is taken there.
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

  it('stays restorable after a failure between the rebuild and the flag', async () => {
    // THE window. Everything before the rebuild is idempotent, so a failure there was always
    // recoverable; a failure after it used to leave archived_at set with the evidence rows
    // already inserted, and from then on every restore died on the evidence UNIQUE constraint
    // while every archive refused with "already archived" — the case could never be restored
    // and never be re-archived again. Realistic triggers are ordinary: an EPERM from a watcher
    // during the transcript rewrites, SQLITE_BUSY, a full disk, the app being killed.
    const { db, home, slug } = await seedArchivableCase()
    const before = contentSnapshot(db, home, slug)
    await archiveCase(db, home, slug, { argusVersion: 'test' })

    await expect(
      restoreCase(db, home, slug, createImmediateQueue(db, home), {
        afterRebuild: () => {
          throw new Error('ENOSPC: no space left on device')
        }
      })
    ).rejects.toThrow(/ENOSPC/)

    // exactly as archived: nothing half-written that a retry would trip over
    const caseId = getCase(db, slug)!.id
    expect(getCase(db, slug)!.archivedAt).not.toBeNull()
    for (const table of ['evidence', 'sessions', 'turns', 'tool_calls']) {
      const n = (
        db.prepare(`SELECT count(*) AS n FROM ${table} WHERE case_id = ?`).get(caseId) as {
          n: number
        }
      ).n
      expect(n, `${table} rows survived a failed restore`).toBe(0)
    }

    // and the whole point: it still restores, completely
    const res = await restoreCase(db, home, slug, createImmediateQueue(db, home))
    expect(res.evidenceRestored).toBe(2)
    expect(res.sessionsRestored).toBe(1)
    expect(getCase(db, slug)!.archivedAt).toBeNull()
    expect(contentSnapshot(db, home, slug)).toEqual(before)
  })

  it('does not duplicate a transcript a killed restore left half-renamed', async () => {
    // registerImportedSessions stages every transcript to <id>.jsonl.import before inserting any
    // row, and writes each rewritten copy under its NEW id. A process death part-way through
    // therefore leaves both: a staged original its own ^\d+\.jsonl$ filter can never see again,
    // and an unclaimed output that the next run reads as one more transcript. The tree merge
    // then puts the bundle's copy of the original back beside that output, and the case comes
    // back with the same conversation twice — two sessions, two files, doubled chat search.
    const { db, home, slug } = await seedArchivableCase()
    const before = contentSnapshot(db, home, slug)
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    await expect(
      restoreCase(db, home, slug, createImmediateQueue(db, home), {
        afterRebuild: () => {
          throw new Error('killed')
        }
      })
    ).rejects.toThrow(/killed/)

    // the leftovers a kill (which runs no unwind and no cleanup) would have left behind
    const sessionsDir = path.join(caseDir(home, slug), 'sessions')
    const original = fs.readdirSync(sessionsDir).filter((f) => /^\d+\.jsonl$/.test(f))
    expect(original).toHaveLength(1)
    const body = fs.readFileSync(path.join(sessionsDir, original[0]), 'utf8')
    fs.renameSync(
      path.join(sessionsDir, original[0]),
      path.join(sessionsDir, `${original[0]}.import`)
    )
    fs.writeFileSync(path.join(sessionsDir, '9001.jsonl'), body)

    const res = await restoreCase(db, home, slug, createImmediateQueue(db, home))

    expect(res.sessionsRestored, 'the killed run’s leftovers were registered again').toBe(1)
    expect(fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.import'))).toEqual([])
    expect(fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1)
    expect(contentSnapshot(db, home, slug).transcripts).toEqual(before.transcripts)
  })

  it('heals a case left half-rebuilt by a build without the transaction', async () => {
    // The state Finding 1 describes, reproduced directly rather than through a seam: archived_at
    // still set, with evidence rows for this case already present. Restore used to die on
    // `UNIQUE constraint failed: evidence.case_id, evidence.rel_path` from here on, forever.
    // The rebuild clears what it is about to write, so this state is just a retry.
    const { db, home, slug } = await seedArchivableCase()
    const before = contentSnapshot(db, home, slug)
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    const caseId = getCase(db, slug)!.id
    db.prepare(
      `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, meta, created_at)
       VALUES (?, 'evidence/sample.log', 'stale', 'log', 1, 'upload', '{}', '2020-01-01T00:00:00Z')`
    ).run(caseId)

    const res = await restoreCase(db, home, slug, createImmediateQueue(db, home))

    expect(res.evidenceRestored).toBe(2)
    expect(contentSnapshot(db, home, slug)).toEqual(before)
  })

  it('refuses a STALE bundle of this same case', async () => {
    // The identity check is a digest comparison, not a slug comparison. A bundle can carry the
    // right slug, verify perfectly, and still not be the snapshot this case was archived from:
    // an older archive of the same case restored over a newer one would silently roll the case
    // back to a state the operator never asked for.
    const { db, home, slug } = await seedArchivableCase()
    const first = await archiveCase(db, home, slug, { argusVersion: 'test' })
    const stale = path.join(home, 'stale.argus.zip')
    fs.copyFileSync(first.bundlePath, stale)
    await restoreCase(db, home, slug, createImmediateQueue(db, home))

    // the case moves on: new evidence, then a second archive with its own digest
    const later = path.join(home, 'later.log')
    fs.writeFileSync(later, 'a fact learned after the first archive\n')
    await ingestArtifact(db, home, createDetection(), createImmediateQueue(db, home), slug, later)
    const second = await archiveCase(db, home, slug, { argusVersion: 'test' })
    expect(second.bundlePath).toBe(caseArchivePath(home, slug))
    fs.copyFileSync(stale, second.bundlePath)

    await expect(restoreCase(db, home, slug, createImmediateQueue(db, home))).rejects.toThrow(
      /does not belong to this case/i
    )
    expect(getCase(db, slug)!.archivedAt).not.toBeNull()
    expect(fs.existsSync(path.join(caseDir(home, slug), 'evidence', 'later.log'))).toBe(false)
    expect((db.prepare(`SELECT count(*) AS n FROM evidence`).get() as { n: number }).n).toBe(0)
  })

  it('refuses a bundle whose row sidecar was tampered with', async () => {
    // The rows travel in a sidecar beside manifest.json, and it rides the SAME verification the
    // case files do: the manifest records its hash. An unverified sidecar would be a hole in
    // the middle of a bundle that is otherwise hashed end to end.
    const { db, home, slug } = await seedArchivableCase()
    const res = await archiveCase(db, home, slug, { argusVersion: 'test' })
    await tamperWithZipEntry(
      res.bundlePath,
      'rows.json',
      JSON.stringify({ turns: [], toolCalls: [], findingPointers: [] })
    )

    await expect(restoreCase(db, home, slug, createImmediateQueue(db, home))).rejects.toThrow(
      /checksum mismatch on rows\.json/
    )
    expect(getCase(db, slug)!.archivedAt).not.toBeNull()
    expect((db.prepare(`SELECT count(*) AS n FROM evidence`).get() as { n: number }).n).toBe(0)
  })

  it('brings the chat index back', async () => {
    const { db, home, slug } = await seedArchivableCase()
    expect(searchMessages(db, slug, 'needle').hits.length).toBeGreaterThan(0)
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    expect(searchMessages(db, slug, 'needle').hits).toEqual([])

    await restoreCase(db, home, slug, createImmediateQueue(db, home))

    const hits = searchMessages(db, slug, 'needle').hits
    expect(hits).toHaveLength(1)
    expect(hits[0].snippet).toContain('«needle»')
    expect(hits[0].sessionId).toBe(
      Number(
        (
          db.prepare(`SELECT id FROM sessions WHERE case_id = ?`).get(getCase(db, slug)!.id) as {
            id: number
          }
        ).id
      )
    )
  })

  it('restores a case whose directory was deleted while it was archived', async () => {
    // The bundle carries case.json, summary.md and the RCA report, so there is no reason this
    // case cannot come back — but the first tree rename threw ENOENT into the user's face.
    const { db, home, slug } = await seedArchivableCase()
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    const dir = caseDir(home, slug)
    const caseJson = fs.readFileSync(path.join(dir, 'case.json'), 'utf8')
    fs.rmSync(dir, { recursive: true, force: true })

    const res = await restoreCase(db, home, slug, createImmediateQueue(db, home))

    expect(res.evidenceRestored).toBe(2)
    expect(fs.readFileSync(path.join(dir, 'case.json'), 'utf8')).toBe(caseJson)
    expect(fs.existsSync(path.join(dir, 'evidence', 'sample.log'))).toBe(true)
    expect(getCase(db, slug)!.archivedAt).toBeNull()
  })

  it('never overwrites a file that stayed on disk with the bundle’s older copy', async () => {
    // The other half of the same rule: only ABSENT files are put back. A summary edited while
    // the case was archived must survive the restore.
    const { db, home, slug } = await seedArchivableCase()
    await archiveCase(db, home, slug, { argusVersion: 'test' })
    const summary = path.join(caseDir(home, slug), 'summary.md')
    fs.writeFileSync(summary, '# edited while archived\n')

    await restoreCase(db, home, slug, createImmediateQueue(db, home))

    expect(fs.readFileSync(summary, 'utf8')).toBe('# edited while archived\n')
  })
})
