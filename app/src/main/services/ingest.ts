import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ArtifactType, EvidenceOrigin, EvidenceRecord } from '../../shared/types'
import {
  dirForMode,
  scopeOfRelPath,
  sidecarRelPath,
  type CaseSubdir,
  type EvidenceScope
} from '../../shared/evidenceScope'
import { DEFAULT_MODE, type ModeId } from '../../shared/modes'
import { caseDir, modeDir } from './paths'
import { getCase } from './caseService'
import { assertCaseWritable } from './caseFreeze'
import type { Detection } from './packs/detection'
import { deleteEvidenceIndex } from './indexer'
import { copyAndHash, hashFile } from './copyHash'
import type { IngestQueueLike } from './ingestQueue'
import { appendDeletionAudit } from './deletionAudit'
import { scopeClause } from './evidenceScopeSql'

function splitName(baseName: string, compoundExts: string[]): { stem: string; ext: string } {
  const lower = baseName.toLowerCase()
  for (const ce of compoundExts) {
    if (lower.endsWith(ce))
      return { stem: baseName.slice(0, -ce.length), ext: baseName.slice(-ce.length) }
  }
  const ext = path.extname(baseName)
  return { stem: baseName.slice(0, baseName.length - ext.length), ext }
}

function collisionFreeName(evidenceDir: string, baseName: string, compoundExts: string[]): string {
  const { stem, ext } = splitName(baseName, compoundExts)
  let candidate = baseName
  for (let i = 1; fs.existsSync(path.join(evidenceDir, candidate)); i++) {
    candidate = `${stem}-${i}${ext}`
  }
  return candidate
}

export function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(64 * 1024)
    let n: number
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

interface EvidenceRow {
  id: number
  case_id: number
  rel_path: string
  sha256: string
  artifact_type: string
  size: number
  origin: string
  meta: string
  created_at: string
}

function rowToEvidence(r: EvidenceRow): EvidenceRecord {
  return {
    id: r.id,
    caseId: r.case_id,
    relPath: r.rel_path,
    sha256: r.sha256,
    artifactType: r.artifact_type as ArtifactType,
    size: r.size,
    origin: r.origin as EvidenceOrigin,
    meta: JSON.parse(r.meta) as Record<string, unknown>,
    createdAt: r.created_at
  }
}

/**
 * One evidence row by id, or null if it is gone.
 *
 * Exists for deferred work (the ingest queue's extraction phase): a caller that
 * runs later than the ingest that queued it must re-read the row rather than hold
 * a record captured at enqueue time, since the row can be rewritten or deleted in
 * between.
 */
export function getEvidenceRecord(db: DatabaseSync, evidenceId: number): EvidenceRecord | null {
  const row = db.prepare(`SELECT * FROM evidence WHERE id = ?`).get(evidenceId)
  return row ? rowToEvidence(row as unknown as EvidenceRow) : null
}

/**
 * Write the evidence row + .meta sidecar and enqueue indexing. Never indexes inline.
 *
 * Takes a precomputed `sha256`/`size` rather than re-reading the file it is
 * registering: every caller already knows both — `ingestArtifact` from the
 * copy pass, the in-memory callers from the buffer they just wrote.
 */
function registerEvidenceRow(
  db: DatabaseSync,
  queue: IngestQueueLike,
  detection: Detection,
  caseSlug: string,
  caseId: number,
  destDir: string,
  topDir: CaseSubdir,
  destName: string,
  originalName: string,
  origin: EvidenceOrigin,
  sha256: string,
  size: number,
  extraMeta: Record<string, unknown>
): EvidenceRecord {
  const destPath = path.join(destDir, destName)
  const artifactType: ArtifactType = detection.detectType(destPath)
  const now = new Date().toISOString()
  const indexable = detection.isText(artifactType)
  const meta: Record<string, unknown> = {
    originalName,
    indexState: indexable ? 'pending' : 'skipped',
    ...extraMeta
  }
  const relPath = `${topDir}/${destName}`

  const res = db
    .prepare(
      `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(caseId, relPath, sha256, artifactType, size, origin, JSON.stringify(meta), now)
  const id = Number(res.lastInsertRowid)

  const record: EvidenceRecord = {
    id,
    caseId,
    relPath,
    sha256,
    artifactType,
    size,
    origin,
    meta,
    createdAt: now
  }
  const metaDir = path.join(destDir, '.meta')
  fs.mkdirSync(metaDir, { recursive: true })
  fs.writeFileSync(path.join(metaDir, `${destName}.json`), JSON.stringify(record, null, 2))

  // Enqueued unconditionally: a non-indexable row still needs phase 2, and extraction
  // is precisely what binary artifacts are enqueued for (see IngestJob.index).
  queue.enqueue({ caseSlug, evidenceId: id, absPath: destPath, size, index: indexable })
  return record
}

/**
 * Copy a file into the case tree as evidence.
 *
 * Async because the copy is the one genuinely large piece of work in ingest:
 * `copyAndHash` streams it a chunk at a time so a multi-GB drop no longer pins
 * the main-process event loop.
 */
export async function ingestArtifact(
  db: DatabaseSync,
  argusHome: string,
  detection: Detection,
  queue: IngestQueueLike,
  caseSlug: string,
  sourcePath: string,
  origin: EvidenceOrigin = 'upload',
  extraMeta: Record<string, unknown> = {},
  mode: ModeId = DEFAULT_MODE
): Promise<EvidenceRecord> {
  const kase = getCase(db, caseSlug)
  if (!kase) throw new Error(`Unknown case: ${caseSlug}`)
  // Nothing may land in a case that is mid-archive (the bundle is already sealed) or archived
  // (the file would not be in the bundle at all). See caseFreeze.ts.
  assertCaseWritable(db, caseSlug)
  const destDir = modeDir(argusHome, caseSlug, mode)
  fs.mkdirSync(destDir, { recursive: true })
  const destName = collisionFreeName(destDir, path.basename(sourcePath), detection.compoundExts())
  const { sha256, size } = await copyAndHash(sourcePath, path.join(destDir, destName))
  return registerEvidenceRow(
    db,
    queue,
    detection,
    caseSlug,
    kase.id,
    destDir,
    dirForMode(mode),
    destName,
    path.basename(sourcePath),
    origin,
    sha256,
    size,
    extraMeta
  )
}

/**
 * Existing evidence in this case with these exact bytes, if any.
 *
 * Case-scoped — matches the `UNIQUE (case_id, rel_path)` grain the evidence table already
 * uses and the same `WHERE case_id = ? AND sha256 = ?` lookup `ingestBytes` runs inline.
 * Exported so other ingest paths that need to dedup by content (e.g. Jira attachment
 * ingest, which must dedup a downloaded temp file before copying it into the case tree)
 * can reuse the exact same grain instead of hand-rolling their own query.
 */
export function findEvidenceBySha256(
  db: DatabaseSync,
  caseId: number,
  sha256: string
): EvidenceRecord | null {
  const row = db
    .prepare(`SELECT * FROM evidence WHERE case_id = ? AND sha256 = ? LIMIT 1`)
    .get(caseId, sha256) as unknown as EvidenceRow | undefined
  return row ? rowToEvidence(row) : null
}

/**
 * Ingest in-memory content (e.g. a fetched Jira ticket) as an evidence file.
 *
 * @internal `knownSha256` — not part of the public shape. It exists only so
 * `ingestBytes` can hand over the digest it already computed for dedupe. External
 * callers must omit it; passing a digest that does not match `content` writes a
 * wrong hash to the row.
 */
export function ingestContent(
  db: DatabaseSync,
  argusHome: string,
  detection: Detection,
  queue: IngestQueueLike,
  caseSlug: string,
  fileName: string,
  content: string | Buffer,
  origin: EvidenceOrigin,
  extraMeta: Record<string, unknown> = {},
  mode: ModeId = DEFAULT_MODE,
  knownSha256?: string
): EvidenceRecord {
  const kase = getCase(db, caseSlug)
  if (!kase) throw new Error(`Unknown case: ${caseSlug}`)
  // Nothing may land in a case that is mid-archive (the bundle is already sealed) or archived
  // (the file would not be in the bundle at all). See caseFreeze.ts.
  assertCaseWritable(db, caseSlug)
  const destDir = modeDir(argusHome, caseSlug, mode)
  fs.mkdirSync(destDir, { recursive: true })
  const destName = collisionFreeName(destDir, fileName, detection.compoundExts())
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  fs.writeFileSync(path.join(destDir, destName), buf)
  // hash the buffer we already hold rather than re-reading the file we just wrote.
  // `knownSha256` lets ingestBytes hand over the digest it computed for dedupe.
  const sha256 = knownSha256 ?? crypto.createHash('sha256').update(buf).digest('hex')
  return registerEvidenceRow(
    db,
    queue,
    detection,
    caseSlug,
    kase.id,
    destDir,
    dirForMode(mode),
    destName,
    fileName,
    origin,
    sha256,
    buf.length,
    extraMeta
  )
}

/**
 * Ingest raw bytes from the renderer (a pasted screenshot, a dropped file).
 *
 * Hashes BEFORE writing so identical content can be deduped, then hands that same
 * digest to `ingestContent` rather than making it hash the buffer a second time.
 * Dedupe is scoped to the case, matching the `UNIQUE (case_id, rel_path)` grain of
 * the evidence table.
 */
export function ingestBytes(
  db: DatabaseSync,
  argusHome: string,
  detection: Detection,
  queue: IngestQueueLike,
  caseSlug: string,
  fileName: string,
  bytes: Buffer,
  origin: EvidenceOrigin,
  extraMeta: Record<string, unknown> = {},
  mode: ModeId = DEFAULT_MODE
): { record: EvidenceRecord; deduped: boolean } {
  const kase = getCase(db, caseSlug)
  if (!kase) throw new Error(`Unknown case: ${caseSlug}`)
  // Nothing may land in a case that is mid-archive (the bundle is already sealed) or archived
  // (the file would not be in the bundle at all). See caseFreeze.ts.
  assertCaseWritable(db, caseSlug)

  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  const existing = db
    .prepare(`SELECT * FROM evidence WHERE case_id = ? AND sha256 = ? LIMIT 1`)
    .get(kase.id, sha256) as unknown as EvidenceRow | undefined
  if (existing) {
    return { record: rowToEvidence(existing), deduped: true }
  }

  const record = ingestContent(
    db,
    argusHome,
    detection,
    queue,
    caseSlug,
    fileName,
    bytes,
    origin,
    extraMeta,
    mode,
    sha256
  )
  return { record, deduped: false }
}

/** Overwrite an existing evidence file in place (ticket refresh): re-hash, re-detect, re-index. */
export function updateEvidenceContent(
  db: DatabaseSync,
  argusHome: string,
  detection: Detection,
  queue: IngestQueueLike,
  evidenceId: number,
  content: string | Buffer,
  extraMeta: Record<string, unknown> = {}
): EvidenceRecord {
  const row = db
    .prepare(
      `SELECT e.*, c.slug AS case_slug FROM evidence e JOIN cases c ON c.id = e.case_id WHERE e.id = ?`
    )
    .get(evidenceId) as unknown as (EvidenceRow & { case_slug: string }) | undefined
  if (!row) throw new Error(`Unknown evidence id: ${evidenceId}`)
  // Overwriting a file in place is a write into the case tree like any other: refuse it while
  // the case is mid-archive or archived. See caseFreeze.ts.
  assertCaseWritable(db, row.case_slug)
  const rec = rowToEvidence(row)
  const absPath = path.join(caseDir(argusHome, row.case_slug), ...rec.relPath.split('/'))
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  fs.writeFileSync(absPath, buf)

  // hash the buffer we already hold rather than re-reading the file we just wrote
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
  const artifactType: ArtifactType = detection.detectType(absPath)
  const size = buf.length
  const indexable = detection.isText(artifactType)
  const meta: Record<string, unknown> = {
    ...rec.meta,
    ...extraMeta,
    indexState: indexable ? 'pending' : 'skipped'
  }
  // never leave both representations on one row (see indexState.ts)
  delete meta.indexed
  // the file was just rewritten on disk — a stale scan-set missing flag would lie
  delete meta.missing
  db.prepare(
    `UPDATE evidence SET sha256 = ?, artifact_type = ?, size = ?, meta = ? WHERE id = ?`
  ).run(sha256, artifactType, size, JSON.stringify(meta), evidenceId)
  // the old index describes bytes that no longer exist; drop it before the re-index
  deleteEvidenceIndex(db, evidenceId)
  queue.enqueue({ caseSlug: row.case_slug, evidenceId, absPath, size, index: indexable })

  const updated: EvidenceRecord = { ...rec, sha256, artifactType, size, meta }
  const sidecarAbs = path.join(
    caseDir(argusHome, row.case_slug),
    ...sidecarRelPath(rec.relPath).split('/')
  )
  fs.mkdirSync(path.dirname(sidecarAbs), { recursive: true })
  fs.writeFileSync(sidecarAbs, JSON.stringify(updated, null, 2))
  return updated
}

/**
 * Register a file already living in the parent's tree (e.g. evidence/.derived/<name> or
 * artifacts/.derived/<name>) in place — no copy. Used by the extraction pipeline for
 * derived text.
 */
export async function ingestDerived(
  db: DatabaseSync,
  argusHome: string,
  queue: IngestQueueLike,
  caseSlug: string,
  absPath: string,
  derivedFromId: number
): Promise<EvidenceRecord> {
  const kase = getCase(db, caseSlug)
  if (!kase) throw new Error(`Unknown case: ${caseSlug}`)
  // Nothing may land in a case that is mid-archive (the bundle is already sealed) or archived
  // (the file would not be in the bundle at all). See caseFreeze.ts.
  assertCaseWritable(db, caseSlug)
  // The derived file belongs to whichever tree its parent lives in — a CI log's extracted
  // text is review material exactly as the log is.
  const parent = listEvidence(db, caseSlug, 'all').find((e) => e.id === derivedFromId)
  if (!parent) throw new Error(`Unknown parent evidence ${derivedFromId} for case ${caseSlug}`)
  const parentDir = dirForMode(scopeOfRelPath(parent.relPath))
  const baseDir = path.join(caseDir(argusHome, caseSlug), parentDir)
  const rel = path.relative(baseDir, absPath)
  if (rel.startsWith('..'))
    throw new Error(`Derived file must live under ${parentDir}/: ${absPath}`)

  // Async, not sha256File: this runs ON the ingest queue, over the extractor's output.
  // A synchronous whole-file hash of a multi-GB trace's extracted text would freeze the
  // main process exactly as the pre-queue ingest did, one step later in the pipeline.
  const sha256 = await hashFile(absPath)
  const size = fs.statSync(absPath).size
  const now = new Date().toISOString()
  const meta = { derivedFrom: derivedFromId, indexState: 'pending' }
  const relPath = `${parentDir}/${rel.split(path.sep).join('/')}`

  const res = db
    .prepare(
      `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, meta, created_at)
       VALUES (?, ?, ?, 'text', ?, 'agent', ?, ?)`
    )
    .run(kase.id, relPath, sha256, size, JSON.stringify(meta), now)
  const id = Number(res.lastInsertRowid)
  queue.enqueue({ caseSlug, evidenceId: id, absPath, size, index: true })

  const record: EvidenceRecord = {
    id,
    caseId: kase.id,
    relPath,
    sha256,
    artifactType: 'text',
    size,
    origin: 'agent',
    meta,
    createdAt: now
  }
  const sidecarAbs = path.join(caseDir(argusHome, caseSlug), ...sidecarRelPath(relPath).split('/'))
  fs.mkdirSync(path.dirname(sidecarAbs), { recursive: true })
  fs.writeFileSync(sidecarAbs, JSON.stringify(record, null, 2))
  return record
}

/**
 * Case evidence, newest first.
 *
 * `scope` defaults to `'investigation'` deliberately: every caller that predates the
 * artifacts split keeps returning exactly what it returned before, and a caller nobody
 * audits under-shows rather than leaking review material into an investigation list.
 * Callers that genuinely span both modes pass `'all'` explicitly.
 */
export function listEvidence(
  db: DatabaseSync,
  caseSlug: string,
  scope: EvidenceScope = 'investigation'
): EvidenceRecord[] {
  const { sql, params } = scopeClause(scope)
  const rows = db
    .prepare(
      `SELECT e.* FROM evidence e JOIN cases c ON c.id = e.case_id
       WHERE c.slug = ?${sql} ORDER BY e.created_at DESC, e.id DESC`
    )
    .all(caseSlug, ...params) as unknown as EvidenceRow[]
  return rows.map(rowToEvidence)
}

/**
 * Hard-delete one evidence item plus (recursively) everything derived from it
 * (meta.derivedFrom chains). Removes FTS rows + DB rows first, then the files
 * and .meta sidecars — a locked file leaves an orphan on disk, never a ghost
 * row. Findings citing the deleted paths keep their (now dangling) text
 * citations by design.
 */
export function deleteEvidence(
  db: DatabaseSync,
  argusHome: string,
  queue: IngestQueueLike,
  caseSlug: string,
  evidenceId: number
): { deleted: Array<{ id: number; relPath: string; sha256: string }> } {
  const kase = getCase(db, caseSlug)
  if (!kase) throw new Error(`Unknown case: ${caseSlug}`)
  const rows = db
    .prepare(`SELECT id, rel_path, sha256, meta FROM evidence WHERE case_id = ?`)
    .all(kase.id) as unknown as Array<{
    id: number
    rel_path: string
    sha256: string
    meta: string
  }>
  const root = rows.find((r) => r.id === evidenceId)
  if (!root) throw new Error(`Unknown evidence ${evidenceId} for case ${caseSlug}`)

  // transitive closure over meta.derivedFrom — grandchildren included
  const doomed = [root]
  const doomedIds = new Set([root.id])
  for (let grew = true; grew;) {
    grew = false
    for (const r of rows) {
      if (doomedIds.has(r.id)) continue
      const parent = (JSON.parse(r.meta) as { derivedFrom?: number }).derivedFrom
      if (parent !== undefined && doomedIds.has(parent)) {
        doomed.push(r)
        doomedIds.add(r.id)
        grew = true
      }
    }
  }

  // Abort BEFORE anything is removed. Each doomed id was enqueued at ingest time,
  // so the queue either still holds the job, is running it, or has finished it —
  // in the first two cases the flag lands and the job stops instead of writing FTS
  // chunks that point at a row this call is about to delete.
  for (const r of doomed) queue.abort(r.id)

  const deleted: Array<{ id: number; relPath: string; sha256: string }> = []
  db.exec('BEGIN')
  try {
    for (const r of doomed) {
      deleteEvidenceIndex(db, r.id)
      db.prepare(`DELETE FROM evidence WHERE id = ?`).run(r.id)
      deleted.push({ id: r.id, relPath: r.rel_path, sha256: r.sha256 })
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  appendDeletionAudit(argusHome, 'evidence.delete', caseSlug, { deleted })

  const caseRoot = caseDir(argusHome, caseSlug)
  for (const r of doomed) {
    fs.rmSync(path.join(caseRoot, ...r.rel_path.split('/')), { force: true })
    fs.rmSync(path.join(caseRoot, ...sidecarRelPath(r.rel_path).split('/')), { force: true })
  }
  return { deleted }
}
