import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { exportCase, verifyBundleArchive } from './bundle'
import { getCase } from './caseService'
import { deleteEvidenceFtsForCase, deleteMessagesFtsForCase } from './ftsIndex'
import { archiveDir, caseArchivePath, caseDir } from './paths'
import { sidecarPath } from './lineIndex'
import { EVIDENCE_DIR, ARTIFACTS_DIR } from '../../shared/evidenceScope'
import type { BundleManifest } from '../../shared/bundle'

/** Trees whose bytes the bundle now holds. Everything else in the case dir — case.json, the
 *  RCA, summary.md — stays, so an archived case still renders from disk as well as from the
 *  database. */
const ARCHIVED_TREES = [EVIDENCE_DIR, ARTIFACTS_DIR, 'sessions']

export interface ArchiveResult {
  slug: string
  bundlePath: string
  /** Bytes removed from cases/<slug> — what the operator actually got back. */
  bytesFreed: number
  evidenceRemoved: number
  sessionsRemoved: number
}

/** Seams the ordering tests inject failures at. Production passes none of these. */
export interface ArchiveDeps {
  exportTo?: (zipPath: string) => Promise<BundleManifest>
  verify?: (zipPath: string) => Promise<BundleManifest>
}

function dirBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  let total = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    total += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size
  }
  return total
}

/**
 * Move a case's bulk out to a verified bundle, keeping its knowledge layer live.
 *
 * The ORDER is the entire safety argument, and every step before the deletes is reversible
 * by doing nothing:
 *   1. export to a temp path
 *   2. re-read the archive and verify every file against the manifest's own sha256 — the
 *      archive, never the sources, because a hash of the thing being deleted proves nothing
 *      about the thing being kept
 *   3. move the verified bundle into <argusHome>/archive/
 *   4. only now delete the FTS rows, the evidence/session/turn/tool_call rows, the line-index
 *      sidecars, and the three on-disk trees
 *   5. mark the case archived
 *
 * What deliberately SURVIVES: the cases row, findings, case_summaries(+fts), rca_jobs,
 * distill_jobs, case_jira_links, pr_bindings. Those are the cross-case corpus behind
 * related-history and the distillation count — deleting them is the mistake this design
 * exists to prevent. Proposals under <argusHome>/proposals are not touched at all.
 */
export async function archiveCase(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  opts: { argusVersion: string },
  deps: ArchiveDeps = {}
): Promise<ArchiveResult> {
  const rec = getCase(db, slug)
  if (!rec) throw new Error(`Unknown case: ${slug}`)
  if (rec.archivedAt) throw new Error(`Case ${slug} is already archived`)

  const dir = caseDir(argusHome, slug)
  const bytesFreed = ARCHIVED_TREES.reduce((n, t) => n + dirBytes(path.join(dir, t)), 0)

  // 1. export to a temp path on the same volume as the archive dir, so step 3 is a rename
  fs.mkdirSync(archiveDir(argusHome), { recursive: true })
  const staging = fs.mkdtempSync(path.join(archiveDir(argusHome), '.staging-'))
  const tmpZip = path.join(staging, `${slug}.argus.zip`)
  let manifest: BundleManifest
  try {
    // includeTranscripts is always true: the originals are about to be removed, and an
    // archive without them is data loss rather than a smaller archive.
    if (deps.exportTo) await deps.exportTo(tmpZip)
    else await exportCase(db, argusHome, slug, tmpZip, { includeTranscripts: true }, opts)

    // 2. verify the ARCHIVE. The manifest kept is the one read back out of the zip, not the
    // one exportCase computed from the source files.
    manifest = deps.verify ? await deps.verify(tmpZip) : await verifyBundleArchive(tmpZip)
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw err
  }

  // 3. move the verified bundle into place
  const bundlePath = caseArchivePath(argusHome, slug)
  fs.renameSync(tmpZip, bundlePath)
  fs.rmSync(staging, { recursive: true, force: true })

  // 4. now, and only now, remove what the bundle holds
  const evidenceRows = db
    .prepare(`SELECT id, rel_path FROM evidence WHERE case_id = ?`)
    .all(rec.id) as unknown as { id: number; rel_path: string }[]
  const sessionRows = db
    .prepare(`SELECT id FROM sessions WHERE case_id = ?`)
    .all(rec.id) as unknown as { id: number }[]

  db.exec('BEGIN')
  try {
    // FTS first: the evidence map lookup joins evidence rows, so it must run before they go.
    deleteEvidenceFtsForCase(db, rec.id)
    deleteMessagesFtsForCase(db, rec.id)
    // findings SURVIVE, but their session/turn pointers would dangle into deleted rows and
    // make a "jump to turn" deep-link resolve to nothing. Null them rather than leaving ids
    // that no longer identify anything.
    db.prepare(`UPDATE findings SET session_id = NULL, turn_id = NULL WHERE case_id = ?`).run(
      rec.id
    )
    db.prepare(`DELETE FROM tool_calls WHERE case_id = ?`).run(rec.id)
    db.prepare(`DELETE FROM turns WHERE case_id = ?`).run(rec.id)
    db.prepare(`DELETE FROM sessions WHERE case_id = ?`).run(rec.id)
    db.prepare(`DELETE FROM evidence WHERE case_id = ?`).run(rec.id)
    // 5. mark it archived in the same transaction: a crash between the deletes and the mark
    // would leave a case with no evidence and no record of why.
    db.prepare(
      `UPDATE cases SET archived_at = ?, archive_path = ?, archive_sha256 = ? WHERE id = ?`
    ).run(new Date().toISOString(), bundlePath, manifestHash(manifest), rec.id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  // Sidecars are a derived cache keyed on the absolute file path; the files are gone, so the
  // checkpoints are dead weight. Best-effort: a locked sidecar must not fail the archive.
  for (const e of evidenceRows) {
    try {
      fs.rmSync(sidecarPath(argusHome, path.join(dir, ...e.rel_path.split('/'))), { force: true })
    } catch {
      /* ignore */
    }
  }
  for (const t of ARCHIVED_TREES) fs.rmSync(path.join(dir, t), { recursive: true, force: true })

  return {
    slug,
    bundlePath,
    bytesFreed,
    evidenceRemoved: evidenceRows.length,
    sessionsRemoved: sessionRows.length
  }
}

/** Stable digest of the manifest's own file hashes — what a later restore compares against to
 *  tell this case's bundle from one swapped or truncated on disk. Exported because restoreCase
 *  recomputes it from the restored bundle's manifest and compares it to cases.archive_sha256:
 *  a valid bundle belonging to a DIFFERENT case, renamed into place, must not restore silently. */
export function manifestHash(manifest: BundleManifest): string {
  const joined = manifest.files
    .map((f) => `${f.path}:${f.sha256}`)
    .sort()
    .join('\n')
  return crypto.createHash('sha256').update(joined).digest('hex')
}
