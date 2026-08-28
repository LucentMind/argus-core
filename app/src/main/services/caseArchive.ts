import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { exportCase, verifyBundleArchive } from './bundle'
import { getCase } from './caseService'
import { freezeCase } from './caseFreeze'
import { deleteEvidenceFtsForCase, deleteMessagesFtsForCase } from './ftsIndex'
import { archiveDir, caseArchivePath, caseDir } from './paths'
import { sidecarPath } from './lineIndex'
import { EVIDENCE_DIR, ARTIFACTS_DIR } from '../../shared/evidenceScope'
import { RCA_REPORT_FILENAMES } from './rca/artifacts'
import type { BundleManifest } from '../../shared/bundle'

/** Trees whose bytes the bundle now holds. Everything else in the case dir — case.json,
 *  summary.md — stays, so an archived case still renders from disk as well as from the
 *  database. `artifacts/` is the one partial case: see KEPT_ARTIFACT_FILES. */
const ARCHIVED_TREES = [EVIDENCE_DIR, ARTIFACTS_DIR, 'sessions']

/**
 * Files inside `artifacts/` that SURVIVE archiving, even though the bundle also carries them.
 *
 * The RCA report is knowledge, not bulk — the same category as `findings` and
 * `case_summaries`, which already survive — and it is what the case view renders. A blanket
 * `artifacts/` removal took it away, so an archived case lost the report it is largely about.
 * They are three small markdown/JSON files; the bulk review artifacts (CI logs, captures)
 * still leave with the bundle.
 *
 * Derived from `rca/artifacts.ts`, which owns these names — a second hand-typed copy here is
 * exactly the drift this project keeps getting bitten by.
 */
const KEPT_ARTIFACT_FILES = new Set<string>(RCA_REPORT_FILENAMES)

export interface ArchiveResult {
  slug: string
  bundlePath: string
  /** Bytes removed from cases/<slug> — what the operator actually got back. */
  bytesFreed: number
  evidenceRemoved: number
  sessionsRemoved: number
}

/** Injected seams. `exportTo`/`verify` are where the ordering tests inject failures;
 *  `hasLiveWork` is a production seam — `archiveCase` is a database-level function with no
 *  access to the agent service, so the caller (the IPC handler) supplies the answer. */
export interface ArchiveDeps {
  exportTo?: (zipPath: string) => Promise<BundleManifest>
  verify?: (zipPath: string) => Promise<BundleManifest>
  /** True when an agent session is still running for this case. Absent means "no live work". */
  hasLiveWork?: () => boolean | Promise<boolean>
  /** Removes one archived tree. A seam only so a test can make it fail: the failure happens
   *  AFTER the commit, where the tolerated-failure behaviour lives, and no real fs state can
   *  be relied on to produce it (Node unlinks even a file another handle holds open). */
  removeTree?: (absPath: string) => void
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

/** Bytes at one removal target, file or directory. */
function pathBytes(p: string): number {
  if (!fs.existsSync(p)) return 0
  return fs.statSync(p).isDirectory() ? dirBytes(p) : fs.statSync(p).size
}

/**
 * The absolute paths archiving deletes, computed ONCE so `bytesFreed` and the deletes can
 * never disagree about what left.
 *
 * Two whole trees, plus `artifacts/`: when that directory holds an RCA report the report
 * files stay and its other entries are removed one by one; when it holds none, the directory
 * itself goes, exactly as before. Safe to compute up front — the case is frozen, so nothing
 * may be written into these trees between here and the deletes.
 */
function removalTargets(dir: string): string[] {
  const out: string[] = []
  for (const t of ARCHIVED_TREES) {
    const target = path.join(dir, t)
    if (t !== ARTIFACTS_DIR) {
      out.push(target)
      continue
    }
    if (!fs.existsSync(target)) continue
    const entries = fs.readdirSync(target)
    if (!entries.some((e) => KEPT_ARTIFACT_FILES.has(e))) {
      out.push(target)
      continue
    }
    for (const e of entries) if (!KEPT_ARTIFACT_FILES.has(e)) out.push(path.join(target, e))
  }
  return out
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
 *      sidecars, and the on-disk bulk (see `removalTargets`)
 *   5. mark the case archived
 *
 * What deliberately SURVIVES: the cases row, findings, case_summaries(+fts), rca_jobs,
 * distill_jobs, case_jira_links, pr_bindings, and the RCA report files on disk. Those are the
 * cross-case corpus behind related-history and the distillation count — deleting them is the
 * mistake this design exists to prevent. Proposals under <argusHome>/proposals are not touched at all.
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
  // Archiving works only on a STABLE case. A running agent writes evidence, transcripts and
  // turns for as long as it runs, and every one of those lands after the bundle snapshot and
  // before the deletes. Refuse rather than race it or stop it behind the user's back.
  if (deps.hasLiveWork && (await deps.hasLiveWork())) {
    throw new Error(
      `Case ${slug} has an agent session still running. Stop it before archiving, so nothing is written after the bundle is sealed.`
    )
  }

  // Freeze BEFORE the export, and release in a finally so no throw can leave a case
  // permanently unwritable. On success the durable guard takes over: archived_at, stamped in
  // the transaction below, is what assertCaseWritable checks from then on.
  //
  // freezeCase THROWS when the case is already frozen, which is what refuses a second,
  // overlapping archive of the same slug — a double-clicked button, a second window, or a
  // retry over a slow first attempt. That refusal has to live in the freeze rather than in an
  // `isCaseFrozen` check here, because only the registry can decide it atomically, and only
  // the returned handle may release: a slug-keyed release let the first archive to finish
  // unfreeze the SECOND one mid-verify, reopening the exact write window this all exists to
  // close. It throws before anything is created, so a refused attempt leaves the case
  // untouched.
  const freeze = freezeCase(slug)
  try {
    return await archiveFrozenCase(db, argusHome, slug, rec.id, opts, deps)
  } finally {
    freeze.release()
  }
}

/** The body of `archiveCase`, running with the case frozen. Split out only so the freeze can
 *  be released in one `finally` without re-indenting the whole rail. */
async function archiveFrozenCase(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  caseId: number,
  opts: { argusVersion: string },
  deps: ArchiveDeps
): Promise<ArchiveResult> {
  const dir = caseDir(argusHome, slug)
  const targets = removalTargets(dir)
  const bytesFreed = targets.reduce((n, p) => n + pathBytes(p), 0)

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
    .all(caseId) as unknown as { id: number; rel_path: string }[]
  const sessionRows = db
    .prepare(`SELECT id FROM sessions WHERE case_id = ?`)
    .all(caseId) as unknown as { id: number }[]

  db.exec('BEGIN')
  try {
    // FTS first: the evidence map lookup joins evidence rows, so it must run before they go.
    deleteEvidenceFtsForCase(db, caseId)
    deleteMessagesFtsForCase(db, caseId)
    // findings SURVIVE, but their session/turn pointers would dangle into deleted rows and
    // make a "jump to turn" deep-link resolve to nothing. Null them rather than leaving ids
    // that no longer identify anything.
    db.prepare(`UPDATE findings SET session_id = NULL, turn_id = NULL WHERE case_id = ?`).run(
      caseId
    )
    db.prepare(`DELETE FROM tool_calls WHERE case_id = ?`).run(caseId)
    db.prepare(`DELETE FROM turns WHERE case_id = ?`).run(caseId)
    db.prepare(`DELETE FROM sessions WHERE case_id = ?`).run(caseId)
    db.prepare(`DELETE FROM evidence WHERE case_id = ?`).run(caseId)
    // 5. mark it archived in the same transaction: a crash between the deletes and the mark
    // would leave a case with no evidence and no record of why.
    db.prepare(
      `UPDATE cases SET archived_at = ?, archive_path = ?, archive_sha256 = ? WHERE id = ?`
    ).run(new Date().toISOString(), bundlePath, manifestHash(manifest), caseId)
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
  // Best-effort, exactly like deleteCase's capture-directory removal: by this point the case
  // IS archived — rows gone, archived_at stamped, bundle in place — so a Windows open handle
  // (EBUSY/EPERM) must not report "archive failed" and send the user into a retry that can
  // only ever hit "already archived". Leftover bytes are a warning, not a failure.
  for (const target of targets) {
    try {
      if (deps.removeTree) deps.removeTree(target)
      else fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } catch (err) {
      console.warn(
        `[archive] failed to remove ${path.relative(dir, target)} for archived case ${slug}:`,
        err
      )
    }
  }

  return {
    slug,
    bundlePath,
    bytesFreed,
    evidenceRemoved: evidenceRows.length,
    sessionsRemoved: sessionRows.length
  }
}

/** Stable digest of the manifest's slug plus its own file hashes — what a later restore
 *  compares against to tell this case's bundle from one swapped or truncated on disk. Exported
 *  because restoreCase recomputes it from the restored bundle's manifest and compares it to
 *  cases.archive_sha256: a valid bundle belonging to a DIFFERENT case, renamed into place, must
 *  not restore silently.
 *
 *  The slug is IN the digest, and must stay in it. Without it the "different case" guarantee
 *  rests on two cases never having byte-identical trees, which is a coincidence rather than a
 *  check. It is fixed now rather than in Task 4 because every archived case persists this value
 *  in `cases.archive_sha256`: changing the algorithm later silently invalidates the restore
 *  check for every bundle already on disk.
 *
 *  Deterministic and order-independent: the file lines are sorted, and the slug is a fixed
 *  header line, so a manifest that lists the same files in a different order digests the same. */
export function manifestHash(manifest: BundleManifest): string {
  const joined = [
    `slug:${manifest.slug}`,
    ...manifest.files.map((f) => `${f.path}:${f.sha256}`).sort()
  ].join('\n')
  return crypto.createHash('sha256').update(joined).digest('hex')
}
