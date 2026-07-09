import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ArtifactType, EvidenceOrigin, EvidenceRecord } from '../../shared/types'
import { caseDir } from './paths'
import { getCase } from './caseService'
import { detectArtifactType } from './detect'
import { indexEvidenceText } from './indexer'

const MAX_INDEX_BYTES = 20 * 1024 * 1024
const TEXT_TYPES: ArtifactType[] = ['applog', 'text', 'list-json']

function collisionFreeName(evidenceDir: string, baseName: string): string {
  const ext = path.extname(baseName)
  const stem = baseName.slice(0, baseName.length - ext.length)
  let candidate = baseName
  for (let i = 1; fs.existsSync(path.join(evidenceDir, candidate)); i++) {
    candidate = `${stem}-${i}${ext}`
  }
  return candidate
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

  const data = fs.readFileSync(destPath)
  const sha256 = crypto.createHash('sha256').update(data).digest('hex')
  const artifactType = detectArtifactType(destPath)
  const size = data.length
  const now = new Date().toISOString()
  const indexable = TEXT_TYPES.includes(artifactType) && size <= MAX_INDEX_BYTES
  const meta: Record<string, unknown> = { originalName: path.basename(sourcePath), indexed: indexable }
  const relPath = `evidence/${destName}`

  const res = db
    .prepare(
      `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(kase.id, relPath, sha256, artifactType, size, origin, JSON.stringify(meta), now)
  const id = Number(res.lastInsertRowid)

  if (indexable) indexEvidenceText(db, id, data.toString('utf8'))

  const record: EvidenceRecord = {
    id, caseId: kase.id, relPath, sha256, artifactType, size, origin, meta, createdAt: now
  }
  fs.writeFileSync(
    path.join(evidenceDir, '.meta', `${destName}.json`),
    JSON.stringify(record, null, 2)
  )
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
