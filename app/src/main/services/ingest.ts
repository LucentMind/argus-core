import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ArtifactType, EvidenceOrigin, EvidenceRecord } from '../../shared/types'
import { caseDir } from './paths'
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
  evidenceDir: string,
  destName: string,
  originalName: string,
  origin: EvidenceOrigin,
  extraMeta: Record<string, unknown>
): EvidenceRecord {
  const destPath = path.join(evidenceDir, destName)
  const sha256 = sha256File(destPath)
  const artifactType: ArtifactType = detection.detectType(destPath)
  const size = fs.statSync(destPath).size
  const now = new Date().toISOString()
  const indexable = detection.isText(artifactType)
  const meta: Record<string, unknown> = { originalName, indexed: indexable, ...extraMeta }
  const relPath = `evidence/${destName}`

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
  fs.writeFileSync(
    path.join(evidenceDir, '.meta', `${destName}.json`),
    JSON.stringify(record, null, 2)
  )
  return record
}

export function ingestArtifact(
  db: DatabaseSync,
  argusHome: string,
  detection: Detection,
  caseSlug: string,
  sourcePath: string,
  origin: EvidenceOrigin = 'upload',
  extraMeta: Record<string, unknown> = {}
): EvidenceRecord {
  const kase = getCase(db, caseSlug)
  if (!kase) throw new Error(`Unknown case: ${caseSlug}`)
  const evidenceDir = path.join(caseDir(argusHome, caseSlug), 'evidence')
  const destName = collisionFreeName(
    evidenceDir,
    path.basename(sourcePath),
    detection.compoundExts()
  )
  fs.copyFileSync(sourcePath, path.join(evidenceDir, destName))
  const rec = registerEvidenceFile(
    db,
    argusHome,
    detection,
    kase.id,
    evidenceDir,
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
  extraMeta: Record<string, unknown> = {}
): EvidenceRecord {
  const kase = getCase(db, caseSlug)
  if (!kase) throw new Error(`Unknown case: ${caseSlug}`)
  const evidenceDir = path.join(caseDir(argusHome, caseSlug), 'evidence')
  const destName = collisionFreeName(evidenceDir, fileName, detection.compoundExts())
  fs.writeFileSync(path.join(evidenceDir, destName), content)
  const rec = registerEvidenceFile(
    db,
    argusHome,
    detection,
    kase.id,
    evidenceDir,
    destName,
    fileName,
    origin,
    extraMeta
  )
  maybeAdvanceToAnalyzing(db, argusHome, kase.id)
  return rec
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
  const destName = rec.relPath.slice('evidence/'.length)
  fs.writeFileSync(
    path.join(caseDir(argusHome, row.case_slug), 'evidence', '.meta', `${destName}.json`),
    JSON.stringify(updated, null, 2)
  )
  return updated
}

/**
 * Register a file already living under evidence/ (e.g. evidence/.derived/<name>)
 * in place — no copy. Used by the extraction pipeline for derived text.
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
  const evidenceDir = path.join(caseDir(argusHome, caseSlug), 'evidence')
  const rel = path.relative(evidenceDir, absPath)
  if (rel.startsWith('..')) throw new Error(`Derived file must live under evidence/: ${absPath}`)

  const sha256 = sha256File(absPath)
  const size = fs.statSync(absPath).size
  const now = new Date().toISOString()
  const meta = { derivedFrom: derivedFromId, indexed: true }
  const relPath = `evidence/${rel.split(path.sep).join('/')}`

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
  fs.mkdirSync(path.join(evidenceDir, '.meta', path.dirname(rel)), { recursive: true })
  fs.writeFileSync(path.join(evidenceDir, '.meta', `${rel}.json`), JSON.stringify(record, null, 2))
  return record
}

export function listEvidence(db: DatabaseSync, caseSlug: string): EvidenceRecord[] {
  const rows = db
    .prepare(
      `SELECT e.* FROM evidence e JOIN cases c ON c.id = e.case_id
       WHERE c.slug = ? ORDER BY e.created_at DESC, e.id DESC`
    )
    .all(caseSlug) as unknown as EvidenceRow[]
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
    const relUnderEvidence = r.rel_path.slice('evidence/'.length)
    fs.rmSync(path.join(caseRoot, ...r.rel_path.split('/')), { force: true })
    fs.rmSync(path.join(caseRoot, 'evidence', '.meta', ...`${relUnderEvidence}.json`.split('/')), {
      force: true
    })
  }
  return { deleted }
}
