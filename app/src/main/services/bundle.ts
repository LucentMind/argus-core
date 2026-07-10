import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Zip } from 'zip-lib'
import type { DatabaseSync } from 'node:sqlite'
import {
  BUNDLE_FORMAT,
  bundleManifestSchema,
  type BundleManifest,
  type BundleWorkspaceRef
} from '../../shared/bundle'
import { caseDir } from './paths'
import { getCase } from './caseService'
import { sha256File } from './ingest'

const execFileAsync = promisify(execFile)

/** Top-level case-dir entries that never travel: the machine-local junction farm. */
const EXPORT_EXCLUDE = new Set(['.claude'])

/** Walk a case dir depth-first; returns POSIX-style paths relative to the case dir. */
export function collectCaseFiles(dir: string, opts: { includeTranscripts: boolean }): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    const abs = rel ? path.join(dir, ...rel.split('/')) : dir
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name
      if (!rel && EXPORT_EXCLUDE.has(ent.name)) continue
      if (!rel && ent.name === 'sessions' && !opts.includeTranscripts) continue
      if (ent.isSymbolicLink()) continue // defensive: links never travel
      if (ent.isDirectory()) walk(childRel)
      else if (ent.isFile()) out.push(childRel)
    }
  }
  walk('')
  return out.sort()
}

/** Capture linked repos as remote+branch+commit refs — checkouts are never copied. */
async function workspaceRefs(db: DatabaseSync, slug: string): Promise<BundleWorkspaceRef[]> {
  const row = db.prepare(`SELECT workspaces FROM cases WHERE slug = ?`).get(slug) as
    { workspaces: string } | undefined
  const stored = JSON.parse(row?.workspaces ?? '[]') as Array<{
    path: string
    remote: string | null
    branch: string | null
  }>
  const refs: BundleWorkspaceRef[] = []
  for (const w of stored) {
    let commit: string | null = null
    try {
      commit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: w.path })).stdout.trim()
    } catch {
      // repo missing/moved — the ref still travels without a commit
    }
    refs.push({ remote: w.remote, branch: w.branch, commit })
  }
  return refs
}

export async function exportCase(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  destFile: string,
  opts: { includeTranscripts: boolean },
  deps: { argusVersion: string }
): Promise<BundleManifest> {
  const kase = getCase(db, slug)
  if (!kase) throw new Error(`Unknown case: ${slug}`)
  const dir = caseDir(argusHome, slug)
  const rels = collectCaseFiles(dir, opts)
  const manifest: BundleManifest = bundleManifestSchema.parse({
    format: BUNDLE_FORMAT,
    slug,
    title: kase.title,
    argusVersion: deps.argusVersion,
    createdAt: new Date().toISOString(),
    includesTranscripts: opts.includeTranscripts,
    workspaces: await workspaceRefs(db, slug),
    files: rels.map((rel) => {
      const abs = path.join(dir, ...rel.split('/'))
      return { path: rel, sha256: sha256File(abs), size: fs.statSync(abs).size }
    })
  })
  const zip = new Zip()
  for (const rel of rels) zip.addFile(path.join(dir, ...rel.split('/')), `case/${rel}`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arguscase-'))
  try {
    const manifestFile = path.join(tmp, 'manifest.json')
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
    zip.addFile(manifestFile, 'manifest.json')
    await zip.archive(destFile)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return manifest
}
