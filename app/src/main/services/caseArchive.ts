import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { extract } from 'zip-lib'
import {
  exportCase,
  readBundleRows,
  registerImportedSessions,
  reindexImportedEvidence,
  verifyBundleArchive
} from './bundle'
import { getCase } from './caseService'
import { freezeCase } from './caseFreeze'
import { requeuePendingIndexes, type IngestQueueLike } from './ingestQueue'
import { deleteEvidenceFtsForCase, deleteMessagesFtsForCase } from './ftsIndex'
import { archiveDir, caseArchivePath, caseDir } from './paths'
import { sidecarPath } from './lineIndex'
import { EVIDENCE_DIR, ARTIFACTS_DIR } from '../../shared/evidenceScope'
import { RCA_REPORT_FILENAMES } from './rca/artifacts'
import type { ArchiveResult, RestoreResult } from '../../shared/archive'
import type { BundleManifest, BundleRows } from '../../shared/bundle'
import type { IndexState } from '../../shared/types'

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

// Declared in shared/ because the preload bridge and the renderer name them too; re-exported
// here so every existing importer of these types is untouched.
export type { ArchiveResult, RestoreResult }

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
    // includeRows: the row sidecar is an ARCHIVE-only payload. Restore is the only consumer —
    // it puts back rows this same installation deleted moments ago — and an ordinary export is
    // a file a user shares, which must not carry the tool-call audit trail or per-turn cost.
    else
      await exportCase(
        db,
        argusHome,
        slug,
        tmpZip,
        { includeTranscripts: true, includeRows: true },
        opts
      )

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

  // Archiving frees a large number of pages. Without this they are reused but never returned
  // to the filesystem, so the file would never shrink no matter how much is archived. This is
  // a no-op unless auto_vacuum is INCREMENTAL, which the contentless-index migration sets —
  // if that has not run yet, archiving still works and the file shrinks at the next VACUUM.
  // Outside the transaction above on purpose: incremental_vacuum cannot run inside one.
  db.exec(`PRAGMA incremental_vacuum`)

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
 *  header line, so a manifest that lists the same files in a different order digests the same.
 *
 *  The row sidecar's digest joins as a second header line, and ONLY when the manifest declares
 *  one. That conditional is deliberate: a bundle written before the sidecar existed must still
 *  digest to the value already stored in its case's `archive_sha256`, or this check would refuse
 *  every archive currently on disk. A bundle that carries rows has them covered — swapping,
 *  truncating or dropping `rows.json` changes this digest and the restore is refused. */
export function manifestHash(manifest: BundleManifest): string {
  const joined = [
    `slug:${manifest.slug}`,
    ...(manifest.rows ? [`rows:${manifest.rows.sha256}`] : []),
    ...manifest.files.map((f) => `${f.path}:${f.sha256}`).sort()
  ].join('\n')
  return crypto.createHash('sha256').update(joined).digest('hex')
}

/** Injected seams, test-only — neither is ever supplied on the production path.
 *
 *  `afterExtract` runs inside the restore's freeze, with the trees back on disk and the
 *  archived flag not yet cleared — the window a concurrent restore or a user write would have
 *  to be refused in. No real fs or timing state can be relied on to produce that window from
 *  outside.
 *
 *  `afterRebuild` runs one step later and is the DANGEROUS window: the evidence and session
 *  rows are rebuilt but the archived flag is still set. A failure there used to leave the case
 *  permanently unrestorable (every retry hit the evidence UNIQUE constraint) and
 *  unre-archivable ("already archived"). It exists so a test can inject a failure exactly
 *  there and prove the case is still restorable afterwards; `afterExtract` fires too early to
 *  reach it, because everything before the rebuild is idempotent anyway. */
export interface RestoreDeps {
  afterExtract?: () => void | Promise<void>
  afterRebuild?: () => void | Promise<void>
}

/**
 * Put one archived tree back.
 *
 * A plain rename only works when the target is absent, which is true of `evidence/` and
 * `sessions/` but NOT of `artifacts/`: archiving deliberately leaves the RCA report files
 * behind, so that directory is still there and non-empty, and `renameSync` onto it throws
 * ENOTEMPTY — which would have skipped the entire artifacts tree. Merging over it is safe
 * rather than merely tolerable: every write path into a kept RCA file goes through
 * `assertCaseWritable`, which refuses an archived case, so the files still on disk are
 * byte-identical to the bundle's copies of them.
 */
function restoreTree(from: string, to: string): void {
  if (!fs.existsSync(to)) {
    fs.renameSync(from, to)
    return
  }
  fs.cpSync(from, to, { recursive: true, force: true })
}

/**
 * Put back the bundle's copy of any NON-archived file that is not on disk — `case.json`,
 * `summary.md`, the RCA report — and nothing else.
 *
 * The rule is one line long: the live copy always wins, and a file that is not there is not a
 * live copy. Archiving leaves these files alone, so ordinarily every one of them exists and
 * this copies nothing; the case it exists for is a case dir the user deleted (or partly
 * deleted) while the case was archived, which otherwise could not be restored at all — the
 * first tree rename threw ENOENT even though the bundle carried the whole tree. It never
 * overwrites, so an edit made since the archive is still safe.
 */
function restoreMissingFiles(from: string, to: string): void {
  const walk = (rel: string): void => {
    const abs = rel ? path.join(from, ...rel.split('/')) : from
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!rel && ARCHIVED_TREES.includes(ent.name)) continue // handled by restoreTree
      const childRel = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) {
        walk(childRel)
        continue
      }
      if (!ent.isFile()) continue
      const dest = path.join(to, ...childRel.split('/'))
      if (fs.existsSync(dest)) continue
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(path.join(abs, ent.name), dest)
    }
  }
  walk('')
}

/**
 * Bring `sessions/` to EXACTLY the set of transcripts the verified bundle carries: delete every
 * file in it the manifest does not list.
 *
 * This replaces inferring a dead run's intent from leftover file names, which restore cannot do
 * soundly in either direction:
 *
 *   - A throw INSIDE `registerImportedSessions`'s loop leaves a staged `<old>.jsonl.import` and
 *     an unclaimed `<new>.jsonl` output. `recoverStagedTranscripts` then deletes every plain
 *     `<digits>.jsonl` — but `restoreTree` has just re-supplied all of them from the bundle, so
 *     it deletes the ORIGINALS and the retry restores only the sessions that happened to still
 *     be staged. On a multi-session case that silently loses whole conversations, their turns
 *     and tool calls, and a finding's deep-link — on a restore reported as successful.
 *   - A hard kill just AFTER that loop leaves no `.import` file at all, so the heuristic is a
 *     no-op and the catch-side unwind never runs. The retry's tree merge re-supplies
 *     `<old>.jsonl` beside the surviving `<new>.jsonl` and every session is registered twice.
 *
 * Both collapse here because restore does not have to infer anything: the manifest is verified,
 * and it lists exactly the transcripts that belong to this case. Anything else in the directory
 * is a previous attempt's debris — a `<newId>.jsonl` output or a `.jsonl.import` staging file —
 * and the bundle's own copy of the real transcript is put back by the tree merge either way.
 *
 * Restore-only, deliberately. `importCase` shares `registerImportedSessions` but not this: it
 * lands into a brand-new case dir it deletes on failure, so it has no bundle-vs-debris question
 * to answer and its behaviour must not change.
 */
function reconcileSessions(manifest: BundleManifest, sessionsDir: string): void {
  if (!fs.existsSync(sessionsDir)) return
  // A bundle written with includeTranscripts: false lists NO sessions/ files at all — not
  // "the empty set for this case", but "transcripts were deliberately withheld". Reconciling
  // against that manifest would read as "delete everything", wiping every transcript the case
  // actually has. Today only archiveFrozenCase calls this, and it always asks for transcripts,
  // but `ArchiveDeps.exportTo` is a supported seam a caller could point at a transcript-less
  // bundle — this function's safety must not depend on a literal three files away.
  if (!manifest.includesTranscripts) return
  const prefix = 'sessions/'
  const keep = new Set(
    manifest.files
      .filter((f) => f.path.startsWith(prefix))
      .map((f) => f.path.slice(prefix.length))
      .filter((name) => name !== '' && !name.includes('/'))
  )
  for (const ent of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    // Files only: a nested directory is not something either the archive rail or this rebuild
    // creates, and removing one would be a delete this function cannot justify.
    if (!ent.isFile() || keep.has(ent.name)) continue
    fs.rmSync(path.join(sessionsDir, ent.name), { force: true })
  }
}

/**
 * Rebuild the rows that live only in the database — `turns`, `tool_calls`, and the findings'
 * session/turn pointers — from the bundle's verified row sidecar.
 *
 * Every id in the sidecar is stale by construction: archiving deleted those rows, and
 * `registerImportedSessions` has just assigned brand-new session ids. `sessionIds` is that ONE
 * mapping, handed in rather than recomputed here, and the turn mapping built below is derived
 * from the rows this function itself inserts — so a finding's pointer and its turn's row can
 * never disagree about which turn they mean.
 *
 * A row whose session did not come back (a bundle written without transcripts) is skipped:
 * `turns.session_id` and `tool_calls.session_id` are NOT NULL and a value pointing at a session
 * that does not exist is worse than an absent row.
 */
function rebuildCaseRows(
  db: DatabaseSync,
  caseId: number,
  rows: BundleRows,
  sessionIds: Map<number, number>
): void {
  const turnIds = new Map<number, number>()
  const insertTurn = db.prepare(
    `INSERT INTO turns (case_id, session_id, turn_index, status, input_tokens, output_tokens,
                        cost_usd, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const t of rows.turns) {
    const sessionId = sessionIds.get(t.sessionId)
    if (sessionId == null) continue
    const res = insertTurn.run(
      caseId,
      sessionId,
      t.turnIndex,
      t.status,
      t.inputTokens,
      t.outputTokens,
      t.costUsd,
      t.durationMs,
      t.createdAt
    )
    turnIds.set(t.id, Number(res.lastInsertRowid))
  }
  const insertCall = db.prepare(
    `INSERT INTO tool_calls (case_id, session_id, turn_id, tool, args_hash, risk, decision,
                             duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const c of rows.toolCalls) {
    const sessionId = sessionIds.get(c.sessionId)
    if (sessionId == null) continue
    insertCall.run(
      caseId,
      sessionId,
      c.turnId == null ? null : (turnIds.get(c.turnId) ?? null),
      c.tool,
      c.argsHash,
      c.risk,
      c.decision,
      c.durationMs,
      c.createdAt
    )
  }
  // The findings themselves never left — only the ids they pointed at did, which archiveCase
  // nulled rather than leave dangling. Point them back at the rebuilt rows so "jump to turn"
  // resolves again. Scoped by case_id as well as id: a pointer entry naming another case's
  // finding must not repoint it.
  const repoint = db.prepare(
    `UPDATE findings SET session_id = ?, turn_id = ? WHERE id = ? AND case_id = ?`
  )
  for (const p of rows.findingPointers) {
    const sessionId = p.sessionId == null ? null : (sessionIds.get(p.sessionId) ?? null)
    const turnId = p.turnId == null ? null : (turnIds.get(p.turnId) ?? null)
    if (sessionId == null && turnId == null) continue
    repoint.run(sessionId, turnId, p.id, caseId)
  }
}

/**
 * Rehydrate an archived case in place.
 *
 * NOT importCase: that creates a NEW case through proposeSlug with collision handling, so
 * running it here would leave a duplicate beside the archived original. The case row never
 * left — only its bulk did — so restore refills the trees and rebuilds the rows that
 * archiveCase removed, then clears the flag.
 *
 * Verifies before extracting, and touches nothing on failure: an archive that has been
 * swapped, truncated or deleted on disk must leave the case exactly as archived rather than
 * half-restored. Verification is in two parts, because they answer different questions:
 *   - `verifyBundleArchive` proves the bundle is internally consistent (integrity)
 *   - the `manifestHash` comparison against `cases.archive_sha256` proves it is THIS case's
 *     bundle (identity). A perfectly valid bundle belonging to a different case, renamed into
 *     this case's archive path, passes the first check and must fail the second.
 *
 * The case stays FROZEN for the whole operation, and the archived flag is cleared LAST. That
 * ordering is the entire concurrency argument: `assertCaseWritable` refuses a case that is
 * frozen OR archived, so between here and the final UPDATE every user write path is closed —
 * there is no window in which the flag is clear but the trees are not yet back, and no window
 * in which a real write can land in a tree that is about to be overwritten from the bundle.
 * Restore's own rebuild does not go through that guard (`reindexImportedEvidence` and
 * `registerImportedSessions` write rows and index entries directly), which is what lets it
 * work inside its own freeze.
 *
 * The rebuild and the flag clear share ONE transaction, so a failure anywhere in them leaves
 * the case exactly as archived and therefore still restorable — see `restoreFrozenCase`.
 *
 * A case whose directory was deleted while it was archived IS restorable: the trees come out
 * of the bundle, and `restoreMissingFiles` puts back `case.json`, `summary.md` and the RCA
 * report — but only files that are absent, never over a live copy.
 */
export async function restoreCase(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  queue: IngestQueueLike,
  deps: RestoreDeps = {}
): Promise<RestoreResult> {
  const rec = getCase(db, slug)
  if (!rec) throw new Error(`Unknown case: ${slug}`)
  if (!rec.archivedAt || !rec.archivePath) throw new Error(`Case ${slug} is not archived`)
  const bundlePath = rec.archivePath
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`Case ${slug} archive is missing from disk: ${bundlePath}`)
  }

  // Frozen for the whole operation, verification included: freezeCase also refuses a second,
  // overlapping restore of the same slug, the same way it refuses a second archive.
  const freeze = freezeCase(slug)
  let counts: { evidenceRestored: number; sessionsRestored: number }
  try {
    counts = await restoreFrozenCase(db, argusHome, slug, rec.id, bundlePath, deps)
  } finally {
    freeze.release()
  }

  // Re-indexing rides the existing background queue rather than blocking the restore: the
  // case is usable immediately and searchEvidenceWithStatus already reports the pending
  // count, so the gap is visible rather than silent. Deliberately AFTER the freeze is
  // released and the flag cleared — the queue's phase 2 runs `extractDerivedText`, which
  // calls assertCaseWritable and would refuse a case still marked frozen or archived.
  const queuedForIndex = requeuePendingIndexes(db, argusHome, queue)

  return { slug, ...counts, queuedForIndex }
}

/** The body of `restoreCase`, running with the case frozen. Split out only so the freeze can
 *  be released in one `finally` without re-indenting the whole rail. */
async function restoreFrozenCase(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  caseId: number,
  bundlePath: string,
  deps: RestoreDeps
): Promise<{ evidenceRestored: number; sessionsRestored: number }> {
  // Verify first: nothing is written until the bundle proves itself, in both senses.
  const manifest = await verifyBundleArchive(bundlePath)
  const stored =
    (
      db.prepare(`SELECT archive_sha256 AS h FROM cases WHERE id = ?`).get(caseId) as
        { h: string | null } | undefined
    )?.h ?? null
  if (!stored || manifestHash(manifest) !== stored) {
    throw new Error(
      `Case ${slug} archive does not belong to this case: manifest digest mismatch on ${bundlePath}. ` +
        `The bundle is intact but is not the one recorded when this case was archived.`
    )
  }

  const dir = caseDir(argusHome, slug)
  fs.mkdirSync(dir, { recursive: true })
  // Staging beside cases/ so restoreTree's rename is a rename rather than a cross-volume copy.
  // realpathSync for the same reason importCase does it: zip-lib's safeSymlinksOnly guard
  // compares an extracted file's realpath against the unresolved target.
  const staging = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(dir), '.restore-')))
  let rows: BundleRows | null
  try {
    await extract(bundlePath, staging, { safeSymlinksOnly: true })
    // Hashed against the manifest again on THIS extraction, for the same reason archiving
    // verifies the archive rather than the sources: the copy about to be consumed is the one
    // that has to prove itself. Null for any bundle written before the sidecar existed.
    rows = readBundleRows(staging, manifest)
    const staged = path.join(staging, 'case')
    // Move only the trees archiveCase removed. Anything else in the bundle (case.json, the
    // RCA, summary.md) is already on disk and is the live copy — the archived copy of a file
    // that never left must not overwrite edits made since. The one exception is a file that
    // is not there at all; see restoreMissingFiles.
    for (const tree of ARCHIVED_TREES) {
      const from = path.join(staged, tree)
      if (fs.existsSync(from)) restoreTree(from, path.join(dir, tree))
    }
    restoreMissingFiles(staged, dir)
    // AFTER the merge, never before: the merge is what re-supplies the bundle's transcripts, and
    // this removes everything else a previous, failed attempt left in sessions/.
    reconcileSessions(manifest, path.join(dir, 'sessions'))
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }

  if (deps.afterExtract) await deps.afterExtract()

  // ONE transaction for the whole rebuild AND the flag, exactly as archiveFrozenCase wraps its
  // deletes and its flag.
  //
  // Without it the three steps autocommitted independently, and any throw between the evidence
  // inserts and the UPDATE — an EPERM from a watcher during the transcript rewrites, SQLITE_BUSY,
  // a full disk, the app being killed — left `archived_at` set with the evidence rows already
  // present. Every later restore then died on `UNIQUE constraint failed: evidence.case_id,
  // evidence.rel_path` and every later archive refused with "already archived": the case could
  // neither be restored nor re-archived, ever. A failed restore has to be retryable.
  //
  // The tree merge above stays outside on purpose — it is idempotent, and files cannot join a
  // database transaction anyway. The two rebuild functions do write files (sidecars rewritten
  // to new ids, transcripts rewritten to new session ids), and a rollback leaves those rewrites
  // in place; both are self-consistent afterwards, so the retry reads them as its starting
  // state and remaps them again.
  let evidenceRestored = 0
  let sessionsRestored = 0
  let sessionIds = new Map<number, number>()
  db.exec('BEGIN')
  try {
    // Belt to the transaction's braces, and the thing that heals a case wedged by a build
    // without it: clear whatever this case still holds of what the rebuild is about to write.
    // On the ordinary path every one of these is a no-op — archiving deleted them all.
    deleteEvidenceFtsForCase(db, caseId)
    deleteMessagesFtsForCase(db, caseId)
    db.prepare(`DELETE FROM tool_calls WHERE case_id = ?`).run(caseId)
    db.prepare(`DELETE FROM turns WHERE case_id = ?`).run(caseId)
    db.prepare(`DELETE FROM sessions WHERE case_id = ?`).run(caseId)
    db.prepare(`DELETE FROM evidence WHERE case_id = ?`).run(caseId)

    // The index lifecycle state each evidence row REALLY held, straight from the verified row
    // sidecar. Without it the rebuild has to guess from the `.meta` sidecars on disk, which are
    // frozen at ingest time — and the guess buries a row that was genuinely still 'pending'
    // because its extraction had never run, so its pack extractor never runs again.
    const indexStates = new Map<string, IndexState>(
      (rows?.evidence ?? []).map((e) => [e.relPath, e.indexState])
    )
    evidenceRestored = reindexImportedEvidence(db, argusHome, caseId, dir, indexStates)
    sessionIds = registerImportedSessions(db, caseId, slug, dir)
    sessionsRestored = sessionIds.size
    // The database-only rows: the tool-call audit trail and the findings' deep-links, both of
    // which one archive/restore cycle used to destroy outright.
    if (rows) rebuildCaseRows(db, caseId, rows, sessionIds)

    if (deps.afterRebuild) await deps.afterRebuild()

    // Last, and only once the trees and rows are actually back: this is what reopens the case
    // to ordinary writes.
    db.prepare(
      `UPDATE cases SET archived_at = NULL, archive_path = NULL, archive_sha256 = NULL WHERE id = ?`
    ).run(caseId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    // Put the transcript file names back with the rows they belong to.
    //
    // The rollback undoes the sessions rows but not the renames `registerImportedSessions`
    // made, and the bundle's row sidecar names sessions by their ORIGINAL id — which is the
    // transcript's file name. Leaving `<newId>.jsonl` behind would therefore cost the retry its
    // turns and tool calls: the sidecar would name a session id no file carries any more. The
    // envelopes inside are rewritten again by the next run, so only the names matter here.
    // Best-effort by design: a failure to rename must not replace the real error.
    //
    // Belt to `reconcileSessions`'s braces since it landed: the retry deletes every file the
    // manifest does not list and the tree merge re-supplies the originals, so correctness no
    // longer depends on this unwind running — which matters because a hard kill never runs it,
    // and because a throw INSIDE registerImportedSessions leaves `sessionIds` unassigned here
    // and this loop iterating an empty map.
    for (const [oldId, newId] of sessionIds) {
      try {
        const sessions = path.join(dir, 'sessions')
        const from = path.join(sessions, `${newId}.jsonl`)
        const to = path.join(sessions, `${oldId}.jsonl`)
        if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to)
      } catch (renameErr) {
        console.warn(`[archive] failed to unwind a restored transcript for ${slug}:`, renameErr)
      }
    }
    throw err
  }

  return { evidenceRestored, sessionsRestored }
}
