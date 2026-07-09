import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ArtifactType, EvidenceOrigin, EvidenceRecord } from '../../shared/types'
import { caseDir } from './paths'
import { getCase } from './caseService'
import { detectArtifactType } from './detect'
import { indexEvidenceFile } from './indexer'

const TEXT_TYPES: ArtifactType[] = ['applog', 'text', 'list-json', 'tagged-json']

const COMPOUND_EXTS = ['.rec.gz', '.list.json', '.bintrace.zip', '.tar.gz']

function splitName(baseName: string): { stem: string; ext: string } {
  const lower = baseName.toLowerCase()
  for (const ce of COMPOUND_EXTS) {
    if (lower.endsWith(ce))
      return { stem: baseName.slice(0, -ce.length), ext: baseName.slice(-ce.length) }
  }
  const ext = path.extname(baseName)
  return { stem: baseName.slice(0, baseName.length - ext.length), ext }
}

function collisionFreeName(evidenceDir: string, baseName: string): string {
  const { stem, ext } = splitName(baseName)
  let candidate = baseName
  for (let i = 1; fs.existsSync(path.join(evidenceDir, candidate)); i++) {
    candidate = `${stem}-${i}${ext}`
  }
  return candidate
}

function sha256File(filePath: string): string {
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

export function ingestArtifact(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string,
  sourcePath: string,
  origin: EvidenceOrigin = 'upload'
): EvidenceRecord {
  const kase = getCase(db, caseSlug)
  if (!kase) throw new Error(`Unknown case: ${caseSlug}`)

  const evidenceDir = path.join(caseDir(argusHome, caseSlug), 'evidence')
  const destName = collisionFreeName(evidenceDir, path.basename(sourcePath))
  const destPath = path.join(evidenceDir, destName)
  fs.copyFileSync(sourcePath, destPath)

  const sha256 = sha256File(destPath)
  const artifactType = detectArtifactType(destPath)
  const size = fs.statSync(destPath).size
  const now = new Date().toISOString()
  const indexable = TEXT_TYPES.includes(artifactType)
  const meta: Record<string, unknown> = {
    originalName: path.basename(sourcePath),
    indexed: indexable
  }
  const relPath = `evidence/${destName}`

  const res = db
    .prepare(
      `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(kase.id, relPath, sha256, artifactType, size, origin, JSON.stringify(meta), now)
  const id = Number(res.lastInsertRowid)

  if (indexable) indexEvidenceFile(db, id, destPath)

  const record: EvidenceRecord = {
    id,
    caseId: kase.id,
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
  indexEvidenceFile(db, id, absPath)

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
