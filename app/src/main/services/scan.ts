// Manual evidence-folder scan (spec §2): reconciles evidence/ on disk with the
// DB. Untracked files register in place, modified files re-hash/re-index with
// priorSha256 kept for audit, missing files are flagged (never deleted).
// Dot-directories (.meta, .derived) are pipeline-managed and skipped.
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ArtifactType, EvidenceRecord, ScanSummary } from '../../shared/types'
import { caseDir } from './paths'
import { getCase, maybeAdvanceToAnalyzing } from './caseService'
import { listEvidence, sha256File, deleteEvidence } from './ingest'
import { deleteEvidenceIndex, indexEvidenceFile } from './indexer'
import { extractDerivedText } from './extraction'
import type { Detection } from './packs/detection'
import type { Extractors } from './packs/extractors'

export interface ScanDeps {
  evidenceChanged: (caseSlug: string) => void
  parsing: (caseSlug: string, evidenceId: number, active: boolean) => void
}

/** Evidence-relative file paths ('/'-joined), depth-first; dot-entries skipped. */
function* walkFiles(dir: string, rel = ''): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) yield* walkFiles(path.join(dir, entry.name), childRel)
    else if (entry.isFile()) yield childRel
  }
}

const isDotPath = (relPath: string): boolean =>
  relPath.split('/').some((seg) => seg.startsWith('.'))

function writeSidecar(evidenceDir: string, rel: string, record: EvidenceRecord): void {
  fs.mkdirSync(path.join(evidenceDir, '.meta', path.dirname(rel)), { recursive: true })
  fs.writeFileSync(path.join(evidenceDir, '.meta', `${rel}.json`), JSON.stringify(record, null, 2))
}

/** Register an untracked file in place — no copy (registerEvidenceFile pattern, nested-path aware). */
function registerScanned(
  db: DatabaseSync,
  detection: Detection,
  caseId: number,
  evidenceDir: string,
  rel: string
): EvidenceRecord {
  const absPath = path.join(evidenceDir, ...rel.split('/'))
  const sha256 = sha256File(absPath)
  const artifactType = detection.detectType(absPath) as ArtifactType
  const size = fs.statSync(absPath).size
  const now = new Date().toISOString()
  const indexable = detection.isText(artifactType)
  const meta: Record<string, unknown> = { originalName: rel.split('/').pop(), indexed: indexable }
  const relPath = `evidence/${rel}`
  const res = db
    .prepare(
      `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, meta, created_at)
       VALUES (?, ?, ?, ?, ?, 'scan', ?, ?)`
    )
    .run(caseId, relPath, sha256, artifactType, size, JSON.stringify(meta), now)
  const id = Number(res.lastInsertRowid)
  const record: EvidenceRecord = {
    id,
    caseId,
    relPath,
    sha256,
    artifactType,
    size,
    origin: 'scan',
    meta,
    createdAt: now
  }
  try {
    if (indexable) indexEvidenceFile(db, id, absPath)
    writeSidecar(evidenceDir, rel, record)
  } catch (err) {
    // error isolation contract: a failed registration must not leave a ghost row
    deleteEvidenceIndex(db, id)
    db.prepare(`DELETE FROM evidence WHERE id = ?`).run(id)
    throw err
  }
  return record
}

/** External edit detected: re-hash/re-detect/re-index in place, keep the old hash for audit. */
function rescanModified(
  db: DatabaseSync,
  detection: Detection,
  evidenceDir: string,
  rec: EvidenceRecord,
  absPath: string,
  sha256: string
): EvidenceRecord {
  const artifactType = detection.detectType(absPath) as ArtifactType
  const size = fs.statSync(absPath).size
  const indexable = detection.isText(artifactType)
  const meta: Record<string, unknown> = {
    ...rec.meta,
    indexed: indexable,
    priorSha256: rec.sha256
  }
  delete meta.missing
  const updated: EvidenceRecord = { ...rec, sha256, artifactType, size, meta }
  // sidecar first: if this throws, nothing has been committed; if the UPDATE below
  // fails instead, the next scan still sees the old sha and retries cleanly
  writeSidecar(evidenceDir, rec.relPath.slice('evidence/'.length), updated)
  db.prepare(
    `UPDATE evidence SET sha256 = ?, artifact_type = ?, size = ?, meta = ? WHERE id = ?`
  ).run(sha256, artifactType, size, JSON.stringify(meta), rec.id)
  deleteEvidenceIndex(db, rec.id)
  if (indexable) indexEvidenceFile(db, rec.id, absPath)
  return updated
}

function setMissing(db: DatabaseSync, rec: EvidenceRecord, missing: boolean): void {
  const meta = { ...rec.meta }
  if (missing) meta.missing = true
  else delete meta.missing
  db.prepare(`UPDATE evidence SET meta = ? WHERE id = ?`).run(JSON.stringify(meta), rec.id)
}

export function scanEvidence(
  db: DatabaseSync,
  argusHome: string,
  detection: Detection,
  extractors: Extractors,
  deps: ScanDeps,
  caseSlug: string
): ScanSummary {
  const kase = getCase(db, caseSlug)
  if (!kase) throw new Error(`Unknown case: ${caseSlug}`)
  const evidenceDir = path.join(caseDir(argusHome, caseSlug), 'evidence')
  const summary: ScanSummary = { added: [], modified: [], missing: [], errors: [] }
  const byRelPath = new Map(listEvidence(db, caseSlug).map((e) => [e.relPath, e]))
  const onDisk = new Set<string>()

  const kickExtraction = (rec: EvidenceRecord): void => {
    deps.parsing(caseSlug, rec.id, true)
    void extractDerivedText(db, argusHome, rec, extractors)
      .then((derived) => {
        if (derived) deps.evidenceChanged(caseSlug)
      })
      .catch((err) =>
        console.warn(`[scan] extraction failed for ${rec.relPath}: ${(err as Error).message}`)
      )
      .finally(() => deps.parsing(caseSlug, rec.id, false))
  }

  if (fs.existsSync(evidenceDir)) {
    for (const rel of walkFiles(evidenceDir)) {
      const relPath = `evidence/${rel}`
      onDisk.add(relPath)
      try {
        const existing = byRelPath.get(relPath)
        if (!existing) {
          kickExtraction(registerScanned(db, detection, kase.id, evidenceDir, rel))
          summary.added.push(relPath)
          continue
        }
        const absPath = path.join(evidenceDir, ...rel.split('/'))
        const sha256 = sha256File(absPath)
        if (sha256 !== existing.sha256) {
          // stale derived rows would duplicate on re-extraction — drop their closure first
          for (const e of byRelPath.values()) {
            if (e.meta.derivedFrom === existing.id) deleteEvidence(db, argusHome, caseSlug, e.id)
          }
          kickExtraction(rescanModified(db, detection, evidenceDir, existing, absPath, sha256))
          summary.modified.push(relPath)
        } else if (existing.meta.missing) {
          setMissing(db, existing, false)
        }
      } catch (err) {
        summary.errors.push({ relPath, error: (err as Error).message })
      }
    }
  }

  for (const [relPath, rec] of byRelPath) {
    if (onDisk.has(relPath) || isDotPath(relPath)) continue
    if (!rec.meta.missing) setMissing(db, rec, true)
    summary.missing.push(relPath)
  }

  // scan is an ingest path like any other: newly registered evidence can move an
  // open case (with a started chat) to analyzing — modified/missing files cannot
  if (summary.added.length > 0) maybeAdvanceToAnalyzing(db, argusHome, kase.id)

  deps.evidenceChanged(caseSlug)
  return summary
}
