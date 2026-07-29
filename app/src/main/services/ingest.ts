import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ArtifactType, EvidenceOrigin, EvidenceRecord } from '../../shared/types'
import {
  ARTIFACTS_PREFIX,
  dirForMode,
  scopeOfRelPath,
  sidecarRelPath,
  type CaseSubdir,
  type EvidenceScope
} from '../../shared/evidenceScope'
import { DEFAULT_MODE, type ModeId } from '../../shared/modes'
import { caseDir, modeDir } from './paths'
import { getCase, maybeAdvanceToAnalyzing } from './caseService'
import type { Detection } from './packs/detection'
import { deleteEvidenceIndex, indexEvidenceFile } from './indexer'
import { appendDeletionAudit } from './deletionAudit'

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

function registerEvidenceFile(
  db: DatabaseSync,
  argusHome: string,
  detection: Detection,
  caseId: number,
  destDir: string,
  topDir: CaseSubdir,
  destName: string,
  originalName: string,
  origin: EvidenceOrigin,
  extraMeta: Record<string, unknown>
): EvidenceRecord {
  const destPath = path.join(destDir, destName)
  const sha256 = sha256File(destPath)
  const artifactType: ArtifactType = detection.detectType(destPath)
  const size = fs.statSync(destPath).size
  const now = new Date().toISOString()
  const indexable = detection.isText(artifactType)
  const meta: Record<string, unknown> = { originalName, indexed: indexable, ...extraMeta }
  const relPath = `${topDir}/${destName}`

  const res = db
    .prepare(
      `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(caseId, relPath, sha256, artifactType, size, origin, JSON.stringify(meta), now)
  const id = Number(res.lastInsertRowid)
  if (indexable) indexEvidenceFile(db, id, destPath, 400, argusHome)

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
  return record
}

export function ingestArtifact(
  db: DatabaseSync,
  argusHome: string,
  detection: Detection,
  caseSlug: string,
  sourcePath: string,
  origin: EvidenceOrigin = 'upload',
  extraMeta: Record<string, unknown> = {},
  mode: ModeId = DEFAULT_MODE
): EvidenceRecord {
  const kase = getCase(db, caseSlug)
  if (!kase) throw new Error(`Unknown case: ${caseSlug}`)
  const destDir = modeDir(argusHome, caseSlug, mode)
  fs.mkdirSync(destDir, { recursive: true })
  const destName = collisionFreeName(destDir, path.basename(sourcePath), detection.compoundExts())
  fs.copyFileSync(sourcePath, path.join(destDir, destName))
  const rec = registerEvidenceFile(
    db,
    argusHome,
    detection,
    kase.id,
    destDir,
    dirForMode(mode),
    destName,
    path.basename(sourcePath),
    origin,
    extraMeta
  )
  maybeAdvanceToAnalyzing(db, argusHome, kase.id)
  return rec
}

/** Ingest in-memory content (e.g. a fetched Jira ticket) as an evidence file. */
export function ingestContent(
  db: DatabaseSync,
  argusHome: string,
  detection: Detection,
  caseSlug: string,
  fileName: string,
  content: string | Buffer,
  origin: EvidenceOrigin,
  extraMeta: Record<string, unknown> = {},
  mode: ModeId = DEFAULT_MODE
): EvidenceRecord {
  const kase = getCase(db, caseSlug)
  if (!kase) throw new Error(`Unknown case: ${caseSlug}`)
  const destDir = modeDir(argusHome, caseSlug, mode)
  fs.mkdirSync(destDir, { recursive: true })
  const destName = collisionFreeName(destDir, fileName, detection.compoundExts())
  fs.writeFileSync(path.join(destDir, destName), content)
  const rec = registerEvidenceFile(
    db,
    argusHome,
    detection,
    kase.id,
    destDir,
    dirForMode(mode),
    destName,
    fileName,
    origin,
    extraMeta
  )
  maybeAdvanceToAnalyzing(db, argusHome, kase.id)
  return rec
}

/**
 * Ingest raw bytes from the renderer (a pasted screenshot, a dropped file).
 *
 * Hashes BEFORE writing so identical content can be deduped — `registerEvidenceFile`
 * hashes the file only after it is already on disk, which is too late to avoid a
 * duplicate copy. Dedupe is scoped to the case, matching the `UNIQUE (case_id, rel_path)`
 * grain of the evidence table.
 */
export function ingestBytes(
  db: DatabaseSync,
  argusHome: string,
  detection: Detection,
  caseSlug: string,
  fileName: string,
  bytes: Buffer,
  origin: EvidenceOrigin,
  extraMeta: Record<string, unknown> = {},
  mode: ModeId = DEFAULT_MODE
): { record: EvidenceRecord; deduped: boolean } {
  const kase = getCase(db, caseSlug)
  if (!kase) throw new Error(`Unknown case: ${caseSlug}`)

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
    caseSlug,
    fileName,
    bytes,
    origin,
    extraMeta,
    mode
  )
  return { record, deduped: false }
}

/** Overwrite an existing evidence file in place (ticket refresh): re-hash, re-detect, re-index. */
export function updateEvidenceContent(
  db: DatabaseSync,
  argusHome: string,
  detection: Detection,
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
  const rec = rowToEvidence(row)
  const absPath = path.join(caseDir(argusHome, row.case_slug), ...rec.relPath.split('/'))
  fs.writeFileSync(absPath, content)

  const sha256 = sha256File(absPath)
  const artifactType: ArtifactType = detection.detectType(absPath)
  const size = fs.statSync(absPath).size
  const indexable = detection.isText(artifactType)
  const meta: Record<string, unknown> = { ...rec.meta, ...extraMeta, indexed: indexable }
  // the file was just rewritten on disk — a stale scan-set missing flag would lie
  delete meta.missing
  db.prepare(
    `UPDATE evidence SET sha256 = ?, artifact_type = ?, size = ?, meta = ? WHERE id = ?`
  ).run(sha256, artifactType, size, JSON.stringify(meta), evidenceId)
  deleteEvidenceIndex(db, evidenceId)
  if (indexable) indexEvidenceFile(db, evidenceId, absPath, 400, argusHome)

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
export function ingestDerived(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string,
  absPath: string,
  derivedFromId: number
): EvidenceRecord {
  const kase = getCase(db, caseSlug)
  if (!kase) throw new Error(`Unknown case: ${caseSlug}`)
  // The derived file belongs to whichever tree its parent lives in — a CI log's extracted
  // text is review material exactly as the log is.
  const parent = listEvidence(db, caseSlug, 'all').find((e) => e.id === derivedFromId)
  if (!parent) throw new Error(`Unknown parent evidence ${derivedFromId} for case ${caseSlug}`)
  const parentDir = dirForMode(scopeOfRelPath(parent.relPath))
  const baseDir = path.join(caseDir(argusHome, caseSlug), parentDir)
  const rel = path.relative(baseDir, absPath)
  if (rel.startsWith('..'))
    throw new Error(`Derived file must live under ${parentDir}/: ${absPath}`)

  const sha256 = sha256File(absPath)
  const size = fs.statSync(absPath).size
  const now = new Date().toISOString()
  const meta = { derivedFrom: derivedFromId, indexed: true }
  const relPath = `${parentDir}/${rel.split(path.sep).join('/')}`

  const res = db
    .prepare(
      `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, meta, created_at)
       VALUES (?, ?, ?, 'text', ?, 'agent', ?, ?)`
    )
    .run(kase.id, relPath, sha256, size, JSON.stringify(meta), now)
  const id = Number(res.lastInsertRowid)
  indexEvidenceFile(db, id, absPath, 400, argusHome)

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
  const predicate =
    scope === 'all' ? '' : scope === 'review' ? ' AND e.rel_path LIKE ?' : ' AND e.rel_path NOT LIKE ?'
  const stmt = db.prepare(
    `SELECT e.* FROM evidence e JOIN cases c ON c.id = e.case_id
     WHERE c.slug = ?${predicate} ORDER BY e.created_at DESC, e.id DESC`
  )
  const rows = (
    scope === 'all' ? stmt.all(caseSlug) : stmt.all(caseSlug, `${ARTIFACTS_PREFIX}%`)
  ) as unknown as EvidenceRow[]
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
