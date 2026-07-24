import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Zip, extract } from 'zip-lib'
import type { DatabaseSync } from 'node:sqlite'
import {
  BUNDLE_FORMAT,
  bundleManifestSchema,
  bundleWorkspaceRefSchema,
  type BundleManifest,
  type BundleWorkspaceRef
} from '../../shared/bundle'
import {
  CASE_RESOLUTIONS,
  type CaseRecord,
  type CaseResolution,
  type CaseStatus,
  type EvidenceRecord
} from '../../shared/types'
import type { BundleInspection } from '../../shared/bundle'
import { caseDir } from './paths'
import { getCase } from './caseService'
import { sha256File } from './ingest'
import { SLUG_RE, scaffoldCaseLinks } from './caseService'
import { indexEvidenceFile } from './indexer'
import { deleteEvidenceFtsForCase } from './ftsIndex'

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

/**
 * Capture linked repos as remote+branch+commit refs — checkouts are never copied.
 * Combines DB-linked workspaces (live checkouts, re-resolved to HEAD) with any
 * `workspaceRefs` already carried in case.json (an imported case's refs — those
 * never get a DB row since the checkout never existed on this machine).
 */
async function workspaceRefs(
  db: DatabaseSync,
  argusHome: string,
  slug: string
): Promise<BundleWorkspaceRef[]> {
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
  try {
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(caseDir(argusHome, slug), 'case.json'), 'utf8')
    ) as { workspaceRefs?: unknown }
    if (Array.isArray(onDisk.workspaceRefs)) {
      for (const entry of onDisk.workspaceRefs) {
        try {
          refs.push(bundleWorkspaceRefSchema.parse(entry))
        } catch {
          // malformed entry — skip rather than fail the whole export
        }
      }
    }
  } catch {
    // missing/corrupt case.json — DB-linked refs still travel
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
    workspaces: await workspaceRefs(db, argusHome, slug),
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

const STATUSES: CaseStatus[] = ['open', 'analyzing', 'rca-drafted', 'closed']

export function proposeSlug(
  db: DatabaseSync,
  argusHome: string,
  slug: string
): { slug: string; collision: boolean } {
  const taken = (s: string): boolean =>
    getCase(db, s) !== null || fs.existsSync(caseDir(argusHome, s))
  if (!taken(slug)) return { slug, collision: false }
  for (let i = 2; i < 100; i++) {
    const candidate = `${slug.slice(0, 60)}-${i}`
    if (!taken(candidate)) return { slug: candidate, collision: true }
  }
  throw new Error(`No free slug variant for ${slug}`)
}

function readManifest(file: string): BundleManifest {
  const manifest = bundleManifestSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
  if (manifest.format > BUNDLE_FORMAT) {
    throw new Error(
      `This bundle uses format v${manifest.format}; this Argus build reads up to v${BUNDLE_FORMAT}. Update Argus to import it.`
    )
  }
  return manifest
}

/** Peek at a bundle without unpacking case content (manifest-only extraction). */
export async function inspectBundle(
  db: DatabaseSync,
  argusHome: string,
  zipPath: string
): Promise<BundleInspection> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arguscase-inspect-'))
  try {
    await extract(zipPath, tmp, {
      onEntry: (e) => {
        if (e.entryName !== 'manifest.json') e.preventDefault()
      }
    })
    const manifestFile = path.join(tmp, 'manifest.json')
    if (!fs.existsSync(manifestFile)) {
      throw new Error('Not an Argus case bundle: manifest.json missing')
    }
    const manifest = readManifest(manifestFile)
    const proposal = proposeSlug(db, argusHome, manifest.slug)
    return { zipPath, manifest, proposedSlug: proposal.slug, collision: proposal.collision }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * True if `rel` is a same-tree relative path: not absolute, no `..` or empty
 * segments, and (when given) prefixed by `requiredPrefix`. Guards both the
 * manifest's file list and sidecar `relPath` values against path traversal.
 */
function safeRelPath(rel: string, requiredPrefix?: string): boolean {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return false
  if (requiredPrefix && !rel.startsWith(requiredPrefix)) return false
  return rel.split('/').every((seg) => seg !== '..' && seg !== '')
}

/** Rebuild evidence rows + FTS from the bundled .meta sidecars (old ids remapped). */
function reindexImportedEvidence(
  db: DatabaseSync,
  argusHome: string,
  caseId: number,
  dir: string
): void {
  const metaRoot = path.join(dir, 'evidence', '.meta')
  const sidecars: string[] = []
  const walk = (rel: string): void => {
    const abs = rel ? path.join(metaRoot, ...rel.split('/')) : metaRoot
    if (!fs.existsSync(abs)) return
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(childRel)
      else if (ent.name.endsWith('.json')) sidecars.push(childRel)
    }
  }
  walk('')
  const records = sidecars.flatMap((rel) => {
    try {
      const rec = JSON.parse(
        fs.readFileSync(path.join(metaRoot, ...rel.split('/')), 'utf8')
      ) as EvidenceRecord
      return typeof rec.relPath === 'string' && safeRelPath(rec.relPath, 'evidence/')
        ? [{ rel, rec }]
        : []
    } catch {
      return [] // orphan/corrupt sidecar — the evidence file stays on disk, just unindexed
    }
  })
  const idMap = new Map<number, number>()
  const insert = db.prepare(
    `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const isDerived = (r: EvidenceRecord): boolean => r.meta?.derivedFrom != null
  // two passes: parents first, then derived rows with derivedFrom remapped
  for (const pass of [0, 1] as const) {
    for (const { rel, rec } of records) {
      if ((pass === 0) === isDerived(rec)) continue
      const meta = { ...rec.meta }
      if (pass === 1) {
        const mapped = idMap.get(Number(meta.derivedFrom))
        if (mapped != null) meta.derivedFrom = mapped
      }
      const res = insert.run(
        caseId,
        rec.relPath,
        rec.sha256,
        rec.artifactType,
        rec.size,
        rec.origin,
        JSON.stringify(meta),
        rec.createdAt
      )
      const newId = Number(res.lastInsertRowid)
      idMap.set(rec.id, newId)
      const abs = path.join(dir, ...rec.relPath.split('/'))
      if (meta.indexed && fs.existsSync(abs)) indexEvidenceFile(db, newId, abs, 400, argusHome)
      fs.writeFileSync(
        path.join(metaRoot, ...rel.split('/')),
        JSON.stringify({ ...rec, id: newId, caseId, meta }, null, 2)
      )
    }
  }
}

/** Matches sessionStore's first-user-message title cap. */
const SESSION_TITLE_MAX = 40

/**
 * Register imported transcripts under the multi-session model: each
 * sessions/<oldId>.jsonl becomes a fresh `sessions` row and its event
 * envelopes are rewritten to the new caseId/caseSlug/sessionId — the ids in
 * the bundle are the SOURCE machine's autoincrements, and both the session
 * switcher (DB) and the renderer's hydrate keying (event envelopes) resolve
 * against the local identity. Without this, imported transcripts are
 * unreachable: files on disk, nothing in the chat.
 */
function registerImportedSessions(
  db: DatabaseSync,
  caseId: number,
  caseSlug: string,
  dir: string
): void {
  const sessionsDir = path.join(dir, 'sessions')
  if (!fs.existsSync(sessionsDir)) return
  const files = fs
    .readdirSync(sessionsDir)
    .filter((f) => /^\d+\.jsonl$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
  // stage out of the numeric namespace first — a freshly assigned id could
  // otherwise collide with a not-yet-processed old file name
  const staged = files.map((f) => {
    const tmp = path.join(sessionsDir, `${f}.import`)
    fs.renameSync(path.join(sessionsDir, f), tmp)
    return tmp
  })
  const now = new Date().toISOString()
  const insert = db.prepare(
    `INSERT INTO sessions (case_id, title, turn_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  for (const tmp of staged) {
    const events: Record<string, unknown>[] = []
    let title = ''
    let turnCount = 0
    for (const line of fs.readFileSync(tmp, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as Record<string, unknown> & {
          type?: string
          payload?: { userText?: unknown }
        }
        if (e.type === 'turn.started') {
          turnCount++
          if (!title && typeof e.payload?.userText === 'string') {
            title = e.payload.userText.trim().slice(0, SESSION_TITLE_MAX)
          }
        }
        events.push(e)
      } catch {
        // torn line — same tolerance as readSessionEvents
      }
    }
    const res = insert.run(caseId, title, turnCount, now, now)
    const newId = Number(res.lastInsertRowid)
    const rewritten = events
      .map((e) => JSON.stringify({ ...e, caseId, caseSlug, sessionId: newId }))
      .join('\n')
    fs.writeFileSync(path.join(sessionsDir, `${newId}.jsonl`), rewritten ? rewritten + '\n' : '')
    fs.rmSync(tmp)
  }
}

export async function importCase(
  db: DatabaseSync,
  argusHome: string,
  zipPath: string,
  slug: string
): Promise<CaseRecord> {
  if (!SLUG_RE.test(slug)) throw new Error(`Invalid case slug: ${JSON.stringify(slug)}`)
  if (getCase(db, slug) || fs.existsSync(caseDir(argusHome, slug))) {
    throw new Error(`Case already exists: ${slug}`)
  }
  const casesRoot = path.join(argusHome, 'cases')
  fs.mkdirSync(casesRoot, { recursive: true })
  // staging dir on the same volume as cases/ so the final move is a plain rename.
  // realpathSync: a symlinked parent (e.g. a symlinked ARGUS_HOME) makes zip-lib's
  // safeSymlinksOnly guard compare an extracted file's realpath against the unresolved
  // staging path and reject the mismatch. Resolve it up front so the guard sees matching paths.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(casesRoot, '.import-')))
  try {
    await extract(zipPath, tmp, { safeSymlinksOnly: true })
    const manifest = readManifest(path.join(tmp, 'manifest.json'))
    const staged = path.join(tmp, 'case')
    // integrity: every manifest entry present with the recorded hash — nothing lands otherwise
    for (const f of manifest.files) {
      if (!safeRelPath(f.path)) throw new Error(`Bundle is corrupt: unsafe path ${f.path}`)
      const abs = path.join(staged, ...f.path.split('/'))
      if (!fs.existsSync(abs)) throw new Error(`Bundle is corrupt: missing ${f.path}`)
      if (sha256File(abs) !== f.sha256) {
        throw new Error(`Bundle is corrupt: checksum mismatch on ${f.path}`)
      }
    }
    // case fields come from the bundled case.json; manifest carries slug/title
    let onDisk: Record<string, unknown> = {}
    try {
      onDisk = JSON.parse(fs.readFileSync(path.join(staged, 'case.json'), 'utf8')) as Record<
        string,
        unknown
      >
    } catch {
      // corrupt/missing case.json — fall back to manifest-only fields
    }
    const status = STATUSES.includes(onDisk.status as CaseStatus)
      ? (onDisk.status as CaseStatus)
      : 'open'
    // A bundled case.json with status "closed" but a missing/invalid resolution lands here
    // as closed + null — this is the same tolerated "legacy" state as pre-migration DB rows
    // (see CaseRecord.resolution). It is intentional, not a bug: do not tighten this to throw
    // or to force a resolution. Any code that reads `resolution` must stay behind a
    // `status === 'closed' && resolution` guard rather than assuming closed implies non-null.
    const resolution =
      status === 'closed' && CASE_RESOLUTIONS.includes(onDisk.resolution as CaseResolution)
        ? (onDisk.resolution as CaseResolution)
        : null
    const tags = Array.isArray(onDisk.tags) ? (onDisk.tags as string[]) : []
    const createdAt =
      typeof onDisk.createdAt === 'string' ? (onDisk.createdAt as string) : new Date().toISOString()
    const now = new Date().toISOString()
    const res = db
      .prepare(
        `INSERT INTO cases (slug, title, jira_key, status, resolution, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        slug,
        manifest.title,
        typeof onDisk.jiraKey === 'string' ? (onDisk.jiraKey as string) : null,
        status,
        resolution,
        JSON.stringify(tags),
        createdAt,
        now
      )
    const caseId = Number(res.lastInsertRowid)
    const dir = caseDir(argusHome, slug)
    try {
      fs.renameSync(staged, dir)
      for (const sub of ['evidence/.meta', 'sessions', '.rca']) {
        fs.mkdirSync(path.join(dir, sub), { recursive: true })
      }
      scaffoldCaseLinks(argusHome, dir)
      // new slug + imported workspaces become unlinked refs (spec §2.2); local paths never travel
      fs.writeFileSync(
        path.join(dir, 'case.json'),
        JSON.stringify(
          { ...onDisk, slug, updatedAt: now, workspaces: [], workspaceRefs: manifest.workspaces },
          null,
          2
        )
      )
      reindexImportedEvidence(db, argusHome, caseId, dir)
      registerImportedSessions(db, caseId, slug, dir)
      return getCase(db, slug)!
    } catch (err) {
      // the rename may have already landed the dir on disk, and reindex may have
      // written evidence_fts rows that the evidence->cases FK cascade won't touch
      // (FTS5 virtual tables don't support foreign keys) — clean up both explicitly.
      // Must run before the cascade deletes the evidence rows the map lookup joins.
      deleteEvidenceFtsForCase(db, caseId)
      db.prepare('DELETE FROM cases WHERE id = ?').run(caseId)
      fs.rmSync(dir, { recursive: true, force: true })
      throw err
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
