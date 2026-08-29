import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Zip, extract } from 'zip-lib'
import type { DatabaseSync } from 'node:sqlite'
import {
  BUNDLE_FORMAT,
  BUNDLE_ROWS_FILE,
  bundleManifestSchema,
  bundleRowsSchema,
  bundleWorkspaceRefSchema,
  type BundleManifest,
  type BundleRows,
  type BundleWorkspaceRef
} from '../../shared/bundle'
import {
  CASE_PHASE_PINS,
  CASE_RESOLUTIONS,
  type CasePhasePin,
  type CaseRecord,
  type CaseResolution,
  type CaseStatus,
  type EvidenceRecord,
  type IndexState
} from '../../shared/types'
import type { BundleInspection } from '../../shared/bundle'
import { caseDir } from './paths'
import { addCaseJiraLink, getCase } from './caseService'
import { sha256File } from './ingest'
import { SLUG_RE, scaffoldCaseLinks } from './caseService'
import { indexEvidenceFile } from './indexer'
import { deleteEvidenceFtsForCase, insertMessageFts } from './ftsIndex'
import { readIndexState } from './indexState'
import { ARTIFACTS_DIR, EVIDENCE_DIR } from '../../shared/evidenceScope'

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

/**
 * The database-only rows a bundle carries beside its files: `turns`, `tool_calls`, and every
 * finding's session/turn pointer.
 *
 * None of these have a file representation, so before this sidecar existed an archive/restore
 * cycle destroyed the whole tool-call audit trail and left every finding's deep-link dead.
 * Read here, at export time, because archiving deletes these rows immediately afterwards.
 *
 * The `evidence` entries carry no file bytes — only each row's REAL index lifecycle state,
 * which exists nowhere else: the `.meta` sidecars travel with the files but were frozen at
 * ingest time. See `bundleRowsSchema`.
 */
export function collectCaseRows(db: DatabaseSync, caseId: number): BundleRows {
  const turns = db
    .prepare(
      `SELECT id, session_id AS sessionId, turn_index AS turnIndex, status,
              input_tokens AS inputTokens, output_tokens AS outputTokens, cost_usd AS costUsd,
              duration_ms AS durationMs, created_at AS createdAt
       FROM turns WHERE case_id = ? ORDER BY id`
    )
    .all(caseId) as unknown[]
  const toolCalls = db
    .prepare(
      `SELECT id, session_id AS sessionId, turn_id AS turnId, tool, args_hash AS argsHash,
              risk, decision, duration_ms AS durationMs, created_at AS createdAt
       FROM tool_calls WHERE case_id = ? ORDER BY id`
    )
    .all(caseId) as unknown[]
  const findingPointers = db
    .prepare(
      `SELECT id, session_id AS sessionId, turn_id AS turnId
       FROM findings WHERE case_id = ? AND (session_id IS NOT NULL OR turn_id IS NOT NULL)
       ORDER BY id`
    )
    .all(caseId) as unknown[]
  const evidence = (
    db
      .prepare(`SELECT id, rel_path AS relPath, meta FROM evidence WHERE case_id = ? ORDER BY id`)
      .all(caseId) as unknown as { id: number; relPath: string; meta: string }[]
  ).map((r) => {
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(r.meta) as Record<string, unknown>
    } catch {
      // unparseable meta — readIndexState's own default ('skipped') is the honest answer
    }
    return { relPath: r.relPath, indexState: readIndexState(meta) }
  })
  return bundleRowsSchema.parse({ turns, toolCalls, evidence, findingPointers })
}

export async function exportCase(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  destFile: string,
  opts: { includeTranscripts: boolean; includeRows?: boolean },
  deps: { argusVersion: string }
): Promise<BundleManifest> {
  const kase = getCase(db, slug)
  if (!kase) throw new Error(`Unknown case: ${slug}`)
  const dir = caseDir(argusHome, slug)
  const rels = collectCaseFiles(dir, opts)
  // The row sidecar ships ONLY when the caller asks for it, and `archiveCase` is the only
  // caller that does. It exists so a restore into this same installation can put back rows that
  // have no file representation — but it is also the complete tool-call audit trail (tool,
  // args_hash, risk, decision) and every turn's token counts, cost and timing. Shipping that in
  // the ordinary "export this case" a user shares is pure disclosure: no importer reads the
  // file (importCase deliberately ignores it), and it routes around `includeTranscripts: false`
  // — withholding the conversation while still handing over its turn-by-turn shape and every
  // tool the agent ran.
  // Serialized before the manifest is built: the manifest records the sidecar's hash, which
  // is what makes a tampered or truncated sidecar detectable at all.
  const rowsBody = opts.includeRows ? JSON.stringify(collectCaseRows(db, kase.id), null, 2) : null
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
    }),
    rows:
      rowsBody == null
        ? undefined
        : {
            sha256: crypto.createHash('sha256').update(rowsBody).digest('hex'),
            size: Buffer.byteLength(rowsBody)
          }
  })
  const zip = new Zip()
  for (const rel of rels) zip.addFile(path.join(dir, ...rel.split('/')), `case/${rel}`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arguscase-'))
  try {
    if (rowsBody != null) {
      const rowsFile = path.join(tmp, BUNDLE_ROWS_FILE)
      fs.writeFileSync(rowsFile, rowsBody)
      zip.addFile(rowsFile, BUNDLE_ROWS_FILE)
    }
    const manifestFile = path.join(tmp, 'manifest.json')
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
    zip.addFile(manifestFile, 'manifest.json')
    await zip.archive(destFile)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return manifest
}

/** Statuses written by builds that predate the phase model, and where each one lands now. */
const LEGACY_STATUS: Record<string, { status: CaseStatus; pin: CasePhasePin | null }> = {
  open: { status: 'open', pin: null },
  closed: { status: 'closed', pin: null },
  analyzing: { status: 'open', pin: null },
  'rca-drafted': { status: 'open', pin: 'rca-drafted' }
}

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
  // realpathSync for the same reason importCase does it: os.tmpdir() is /var/folders/…
  // on macOS, a symlink into /private/var, and zip-lib compares an extracted file's
  // realpath against the unresolved target — so its guard rejects manifest.json as
  // "outside" a folder it is plainly inside, and no bundle can be inspected at all.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arguscase-inspect-')))
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

/**
 * Check every manifest entry against the extracted tree. Throws naming the first bad path.
 *
 * Extracted from importCase so the archive path (caseArchive.ts) verifies bundles the same
 * way rather than growing a second copy: archiving DELETES the originals on the strength of
 * this check, so the two must never drift.
 */
export function verifyStagedBundle(stagedCaseDir: string, manifest: BundleManifest): void {
  for (const f of manifest.files) {
    if (!safeRelPath(f.path)) throw new Error(`Bundle is corrupt: unsafe path ${f.path}`)
    const abs = path.join(stagedCaseDir, ...f.path.split('/'))
    if (!fs.existsSync(abs)) throw new Error(`Bundle is corrupt: missing ${f.path}`)
    if (sha256File(abs) !== f.sha256) {
      throw new Error(`Bundle is corrupt: checksum mismatch on ${f.path}`)
    }
  }
}

/**
 * Read and verify the row sidecar out of an EXTRACTED bundle root (the dir holding
 * `manifest.json`), returning null when the bundle predates the sidecar.
 *
 * The sidecar is verified exactly as the case files are — against a hash the manifest records
 * — so a tampered or truncated `rows.json` is a hard failure rather than a silent rebuild of
 * the wrong audit trail. A bundle with no `rows` entry in its manifest is not an error: every
 * bundle exported before this existed is one, and `importCase` must keep reading them.
 * The converse (a `rows` entry with no readable file) IS an error: the bundle claims rows it
 * cannot produce.
 */
export function readBundleRows(rootDir: string, manifest: BundleManifest): BundleRows | null {
  if (!manifest.rows) return null
  const file = path.join(rootDir, BUNDLE_ROWS_FILE)
  if (!fs.existsSync(file)) throw new Error(`Bundle is corrupt: missing ${BUNDLE_ROWS_FILE}`)
  const body = fs.readFileSync(file)
  const sha = crypto.createHash('sha256').update(body).digest('hex')
  if (sha !== manifest.rows.sha256) {
    throw new Error(`Bundle is corrupt: checksum mismatch on ${BUNDLE_ROWS_FILE}`)
  }
  try {
    return bundleRowsSchema.parse(JSON.parse(body.toString('utf8')))
  } catch (err) {
    throw new Error(`Bundle is corrupt: unreadable ${BUNDLE_ROWS_FILE} (${(err as Error).message})`)
  }
}

/**
 * Extract a bundle to a temp dir, verify every file in it, and return its manifest.
 *
 * Verifies the ARCHIVE, not the source files it was built from: a hash computed from the
 * thing about to be deleted proves nothing about the thing being kept. This is the check
 * that makes archiving safe to follow with a delete.
 */
export async function verifyBundleArchive(zipPath: string): Promise<BundleManifest> {
  // realpathSync for the same reason inspectBundle does it: os.tmpdir() is a symlink into
  // /private/var on macOS and zip-lib's guard compares realpaths.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'argus-verify-')))
  try {
    await extract(zipPath, tmp, { safeSymlinksOnly: true })
    const manifestFile = path.join(tmp, 'manifest.json')
    if (!fs.existsSync(manifestFile)) {
      throw new Error('Not an Argus case bundle: manifest.json missing')
    }
    const manifest = readManifest(manifestFile)
    verifyStagedBundle(path.join(tmp, 'case'), manifest)
    // The sidecar rides the same verification the case files get; a bundle that claims rows
    // it cannot produce, or produces ones that do not hash, fails here rather than in the
    // middle of a restore's rebuild.
    readBundleRows(tmp, manifest)
    return manifest
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Rebuild evidence rows + FTS from the bundled .meta sidecars (old ids remapped).
 * Returns how many sidecar-backed rows were registered.
 *
 * Exported for `restoreCase`, which faces the identical problem — a case dir full of files
 * whose evidence rows are gone — and must reuse this rather than grow a second copy of the
 * two-pass derivedFrom remap.
 *
 * `indexStates` (rel path → the state that row ACTUALLY held) is restore's: it comes from the
 * bundle's row sidecar, the only record of the truth. Import has no such record and keeps the
 * old inference. See the comment at the `recorded` branch below for why inferring is unsound.
 */
export function reindexImportedEvidence(
  db: DatabaseSync,
  argusHome: string,
  caseId: number,
  dir: string,
  indexStates?: ReadonlyMap<string, IndexState>
): number {
  // Both trees are re-registered from their own sidecars; a case may hold either or both,
  // and a directory that does not exist simply contributes nothing.
  const records = [EVIDENCE_DIR, ARTIFACTS_DIR].flatMap((top) => {
    const metaRoot = path.join(dir, top, '.meta')
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
    return sidecars.flatMap((rel) => {
      const sidecarAbs = path.join(metaRoot, ...rel.split('/'))
      try {
        const rec = JSON.parse(fs.readFileSync(sidecarAbs, 'utf8')) as EvidenceRecord
        return typeof rec.relPath === 'string' && safeRelPath(rec.relPath, `${top}/`)
          ? [{ sidecarAbs, rec }]
          : []
      } catch {
        return [] // orphan/corrupt sidecar — the file stays on disk, just unindexed
      }
    })
  })
  const idMap = new Map<number, number>()
  const insert = db.prepare(
    `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const isDerived = (r: EvidenceRecord): boolean => r.meta?.derivedFrom != null
  // two passes: parents first, then derived rows with derivedFrom remapped
  for (const pass of [0, 1] as const) {
    for (const { sidecarAbs, rec } of records) {
      if ((pass === 0) === isDerived(rec)) continue
      const meta = { ...rec.meta }
      if (pass === 1) {
        const mapped = idMap.get(Number(meta.derivedFrom))
        if (mapped != null) meta.derivedFrom = mapped
      }
      const abs = path.join(dir, ...rec.relPath.split('/'))
      const exists = fs.existsSync(abs)
      // The sidecars on disk were written at INGEST time, when the row was still 'pending',
      // and were never rewritten when the queue set 'indexed' on the row — so replaying them
      // verbatim resurrects a stale 'pending' for a file this function is about to index
      // inline. requeuePendingIndexes then re-queues every one of them, and the production
      // queue's phase 2 re-runs the (up to ten-minute) extractor over files whose derived rows
      // the bundle already carries.
      //
      // Neither value on disk is trustworthy, so the inference below (anything not 'skipped'
      // becomes 'indexed') is a GUESS, and it is wrong in one direction that costs data: a row
      // that was still 'pending' at export time BECAUSE ITS EXTRACTION HAD NEVER RUN comes back
      // stamped 'indexed', requeuePendingIndexes only sweeps pending/errored, and that file's
      // pack extractor never runs again. When the caller can supply the state the row really
      // held — restore, from the bundle's verified row sidecar — reinstate it instead of
      // guessing.
      const recorded = indexStates?.get(rec.relPath)
      let state: IndexState
      if (recorded) {
        // 'indexing' records a run that was interrupted; nothing is in flight after a restore,
        // so it comes back as the retryable state the sweep understands.
        state = recorded === 'indexing' ? 'pending' : recorded
        // An 'indexed' row whose file did not come back cannot be re-indexed inline. 'pending'
        // sends it to the sweep, which turns a missing file into 'error' — rather than leaving
        // an 'indexed' claim on a row with nothing behind it.
        if (state === 'indexed' && !exists) state = 'pending'
      } else {
        state = readIndexState(meta) !== 'skipped' && exists ? 'indexed' : readIndexState(meta)
      }
      const willIndex = state === 'indexed' && exists
      // With a recorded state the row is stamped either way — the record is authoritative even
      // when it says "not indexed". Without one, only the inferred 'indexed' is written, which
      // is exactly what import did before and still does.
      if (recorded || willIndex) {
        meta.indexState = state
        delete meta.indexed // never leave both representations on one row
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
      if (willIndex) indexEvidenceFile(db, newId, abs, 400, argusHome)
      fs.writeFileSync(sidecarAbs, JSON.stringify({ ...rec, id: newId, caseId, meta }, null, 2))
    }
  }
  return records.length
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
 *
 * Returns the OLD session id (the transcript's file name) → new session id mapping. That map is
 * the single representation of the remap: `restoreCase` rebuilds `turns`, `tool_calls` and the
 * findings' pointers through this very map rather than recomputing the correspondence, because
 * a second derivation of the same fact is precisely how the two drift apart.
 *
 * Exported for `restoreCase`: archiving deletes the `sessions` rows and their chat index while
 * the transcripts travel in the bundle, so a restore lands in exactly this state — jsonl files
 * on disk with no rows behind them — and the rebuild must be the same code, not a copy. The
 * ids in a restored bundle are this machine's own former autoincrements rather than a foreign
 * machine's, but they are equally stale (their rows were deleted), so the remap is the same
 * operation either way.
 */
export function registerImportedSessions(
  db: DatabaseSync,
  caseId: number,
  caseSlug: string,
  dir: string
): Map<number, number> {
  const sessionIds = new Map<number, number>()
  const sessionsDir = path.join(dir, 'sessions')
  if (!fs.existsSync(sessionsDir)) return sessionIds
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
    const indexable: { role: string; content: string }[] = []
    let title = ''
    let turnCount = 0
    for (const line of fs.readFileSync(tmp, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as Record<string, unknown> & {
          type?: string
          payload?: { userText?: unknown; text?: unknown }
        }
        if (e.type === 'turn.started') {
          turnCount++
          const t = (e.payload as { userText?: unknown })?.userText
          if (typeof t === 'string') {
            if (!title) title = t.trim().slice(0, SESSION_TITLE_MAX)
            indexable.push({ role: 'user', content: t })
          }
        } else if (e.type === 'assistant.message') {
          const t = (e.payload as { text?: unknown })?.text
          if (typeof t === 'string') indexable.push({ role: 'assistant', content: t })
        }
        events.push(e)
      } catch {
        // torn line — same tolerance as readSessionEvents
      }
    }
    const res = insert.run(caseId, title, turnCount, now, now)
    const newId = Number(res.lastInsertRowid)
    sessionIds.set(parseInt(path.basename(tmp), 10), newId)
    // Without this the imported transcript is on disk and in the chat but invisible to
    // chatSearch — insertMessageFts's only other caller is the live mirror, which never
    // runs for an imported session.
    for (const m of indexable) {
      if (m.content.trim()) insertMessageFts(db, m.content, caseId, newId, null, m.role)
    }
    const rewritten = events
      .map((e) => JSON.stringify({ ...e, caseId, caseSlug, sessionId: newId }))
      .join('\n')
    fs.writeFileSync(path.join(sessionsDir, `${newId}.jsonl`), rewritten ? rewritten + '\n' : '')
    fs.rmSync(tmp)
  }
  return sessionIds
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
    verifyStagedBundle(staged, manifest)
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
    // LEGACY_STATUS is an object literal, so a plain `LEGACY_STATUS[key] ?? fallback` resolves
    // an inherited key (toString, constructor, __proto__, …) to a truthy function/object
    // instead of falling through to the default below — legacy.status then reads as
    // undefined, which throws an opaque SQLite bind error on the INSERT rather than landing
    // safely as 'open'. Object.hasOwn rejects the prototype chain outright.
    const statusKey = String(onDisk.status ?? '')
    const legacy = (Object.hasOwn(LEGACY_STATUS, statusKey) ? LEGACY_STATUS[statusKey] : null) ?? {
      status: 'open',
      pin: null
    }
    const status = legacy.status
    // A bundled case.json with status "closed" but a missing/invalid resolution lands here
    // as closed + null — this is the same tolerated "legacy" state as pre-migration DB rows
    // (see CaseRecord.resolution). It is intentional, not a bug: do not tighten this to throw
    // or to force a resolution. Any code that reads `resolution` must stay behind a
    // `status === 'closed' && resolution` guard rather than assuming closed implies non-null.
    const resolution =
      status === 'closed' && CASE_RESOLUTIONS.includes(onDisk.resolution as CaseResolution)
        ? (onDisk.resolution as CaseResolution)
        : null
    // An explicit pin in the bundle wins; otherwise a legacy rca-drafted status becomes one,
    // stamped at the bundle's updatedAt — the best approximation the file still carries.
    const phasePin = CASE_PHASE_PINS.includes(onDisk.phasePin as CasePhasePin)
      ? (onDisk.phasePin as CasePhasePin)
      : legacy.pin
    const phasePinnedAt = phasePin
      ? ((onDisk.phasePinnedAt as string | undefined) ??
        (onDisk.updatedAt as string | undefined) ??
        new Date().toISOString())
      : null
    const tags = Array.isArray(onDisk.tags) ? (onDisk.tags as string[]) : []
    const createdAt =
      typeof onDisk.createdAt === 'string' ? (onDisk.createdAt as string) : new Date().toISOString()
    const now = new Date().toISOString()
    const res = db
      .prepare(
        `INSERT INTO cases
           (slug, title, jira_key, ticket_provider, status, resolution, phase_pin, phase_pinned_at, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        slug,
        manifest.title,
        typeof onDisk.jiraKey === 'string' ? (onDisk.jiraKey as string) : null,
        onDisk.ticketProvider === 'github' ? 'github' : 'jira',
        status,
        resolution,
        phasePin,
        phasePinnedAt,
        JSON.stringify(tags),
        createdAt,
        now
      )
    const caseId = Number(res.lastInsertRowid)
    const dir = caseDir(argusHome, slug)
    try {
      fs.renameSync(staged, dir)
      for (const sub of ['evidence/.meta', 'artifacts/.meta', 'sessions', '.rca']) {
        fs.mkdirSync(path.join(dir, sub), { recursive: true })
      }
      scaffoldCaseLinks(argusHome, dir)
      // new slug + imported workspaces become unlinked refs (spec §2.2); local paths never travel.
      // status/phasePin/phasePinnedAt are written explicitly (not left to the `...onDisk`
      // spread) so a legacy bundle's on-disk literal ("analyzing", "rca-drafted", ...) is
      // normalized to match what actually landed in the DB row above. phase/actionItems are
      // DERIVED — never stored (Finding 7, same as createCase's fix) — so a pre-fix bundle's
      // stored copies must not survive the `...onDisk` spread either.
      fs.writeFileSync(
        path.join(dir, 'case.json'),
        JSON.stringify(
          {
            ...onDisk,
            slug,
            status,
            phasePin,
            phasePinnedAt,
            phase: undefined,
            actionItems: undefined,
            lastWorkedAt: undefined,
            updatedAt: now,
            workspaces: [],
            workspaceRefs: manifest.workspaces
          },
          null,
          2
        )
      )
      reindexImportedEvidence(db, argusHome, caseId, dir)
      // The session-id remap is returned but not needed here: import deliberately does NOT
      // consume the bundle's `rows.json`. `turns` and `tool_calls` are a record of what an
      // agent did on the EXPORTING machine under that machine's permission policy — its risk
      // verdicts and allow/deny decisions — and replaying them here would present another
      // operator's audit trail as this installation's own. Findings do not travel in a bundle
      // at all, so the pointer half would be a no-op regardless. Restore is the opposite case:
      // the rows are this machine's, deleted moments earlier by its own archive.
      registerImportedSessions(db, caseId, slug, dir)
      // Restore case_jira_links from the mirrored jiraSources array (see caseService.ts's
      // mirrorJiraSources) — without this, an imported case LOOKS linked (case.json still
      // carries jiraSources: [...] and the source's evidence files survive) but
      // listCaseJiraLinks returns [], so refresh's source loop silently iterates nothing
      // forever. The baseline is intentionally NOT copied from the export: this machine
      // never observed the source's live attachments, so attachmentIds starts at [] (what
      // addCaseJiraLink already defaults to) and the next refresh re-establishes it
      // honestly rather than inventing a baseline nobody here actually saw.
      const jiraSources = Array.isArray(onDisk.jiraSources)
        ? (onDisk.jiraSources as unknown[]).filter((k): k is string => typeof k === 'string')
        : []
      for (const key of jiraSources) {
        try {
          addCaseJiraLink(db, argusHome, slug, key)
        } catch (err) {
          console.warn(
            `[bundle] failed to restore source link ${key} for ${slug}: ${(err as Error).message}`
          )
        }
      }
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
