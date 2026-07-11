import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ArtifactType, FileNode, FileReadResult } from '../../shared/types'
import { getCase, SLUG_RE } from './caseService'
import { caseDir } from './paths'

export const FILE_READ_CAP = 2 * 1024 * 1024

/** Entries never shown or walked: junction farm + evidence sidecar metadata. */
const HIDDEN = new Set(['.claude', '.meta'])

/**
 * A hostile slug ('..', '../../x') relocates the case root itself — validate
 * before building any path (or starting a watcher) from it. Same rule
 * createCase enforces.
 */
export function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) throw new Error(`Invalid case slug: ${JSON.stringify(slug)}`)
}

export function resolveCasePath(argusHome: string, slug: string, relPath: string): string {
  assertSlug(slug)
  const root = path.resolve(caseDir(argusHome, slug))
  const target = path.resolve(root, relPath)
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Path is outside the case directory: ${relPath}`)
  }
  // The lexical check above can't see symlinks/junctions planted inside the case
  // dir; when the target exists, its real path must also stay under the real root.
  if (fs.existsSync(target)) {
    const realRoot = fs.realpathSync(root)
    const realTarget = fs.realpathSync(target)
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new Error(`Path is outside the case directory: ${relPath}`)
    }
  }
  return target
}

interface EvidenceRow {
  id: number
  rel_path: string
  artifact_type: string
  meta: string
}

function evidenceByRelPath(db: DatabaseSync, slug: string): Map<string, EvidenceRow> {
  const rows = db
    .prepare(
      `SELECT e.id, e.rel_path, e.artifact_type, e.meta
       FROM evidence e JOIN cases c ON c.id = e.case_id WHERE c.slug = ?`
    )
    .all(slug) as unknown as EvidenceRow[]
  return new Map(rows.map((r) => [r.rel_path, r]))
}

function walk(dir: string, rel: string, byPath: Map<string, EvidenceRow>): FileNode[] {
  const out: FileNode[] = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (HIDDEN.has(ent.name) || ent.isSymbolicLink()) continue
    const relPath = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      out.push({
        name: ent.name,
        relPath,
        kind: 'dir',
        size: 0,
        children: walk(path.join(dir, ent.name), relPath, byPath)
      })
    } else if (ent.isFile()) {
      const ev = byPath.get(relPath)
      const meta = ev ? (JSON.parse(ev.meta) as { derivedFrom?: number }) : undefined
      out.push({
        name: ent.name,
        relPath,
        kind: 'file',
        size: fs.statSync(path.join(dir, ent.name)).size,
        ...(ev
          ? {
              evidence: {
                id: ev.id,
                artifactType: ev.artifact_type as ArtifactType,
                derived: typeof meta?.derivedFrom === 'number'
              }
            }
          : {})
      })
    }
  }
  // dirs first, then files, each alphabetical — stable explorer ordering
  return out.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)
  )
}

export function listCaseFiles(db: DatabaseSync, argusHome: string, slug: string): FileNode[] {
  if (!getCase(db, slug)) throw new Error(`Unknown case: ${slug}`)
  const root = caseDir(argusHome, slug)
  if (!fs.existsSync(root)) return []
  return walk(root, '', evidenceByRelPath(db, slug))
}

export function readCaseFile(argusHome: string, slug: string, relPath: string): FileReadResult {
  const p = resolveCasePath(argusHome, slug, relPath)
  const stat = fs.statSync(p)
  if (!stat.isFile()) throw new Error(`Not a file: ${relPath}`)
  if (stat.size > FILE_READ_CAP) return { tooLarge: true }
  return { content: fs.readFileSync(p, 'utf8') }
}
