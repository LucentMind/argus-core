import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { TIERS } from './agent/skillsResolver'
import {
  assetPathError,
  isExecutableAsset,
  isSkillTempDir,
  MAX_ASSET_FILE_BYTES,
  MAX_ASSET_FILES,
  MAX_ASSET_TOTAL_BYTES
} from '../../shared/skillAssets'
import type { SkillAssetTier } from '../../shared/skillAssets'
import {
  dropSkillAssetReview,
  recordAssetReviews,
  renameSkillAssetReview,
  sha256Hex
} from './skillAssetReviews'
import type {
  SkillFileEntry,
  SkillFileRead,
  SkillFileWriteResult
} from '../../shared/skillFilesIpc'

/** The skill directory that wins tier precedence, or null. Same `TIERS` array the resolver and
 *  the run gate share — a second copy of the precedence order is the defect this repo keeps
 *  re-learning. */
function winner(argusHome: string, skill: string): { dir: string; tier: SkillAssetTier } | null {
  if (!skill || isSkillTempDir(skill)) return null
  for (const { tier, root } of TIERS) {
    const dir = path.join(root(argusHome), skill)
    try {
      if (fs.statSync(dir).isDirectory()) return { dir, tier }
    } catch {
      // not in this tier
    }
  }
  return null
}

/** A skill is yours iff it resolves to the user tier — the same rule `forkSkill`'s ownership
 *  guard and `isAssetEditable('skill', tier)` apply to SKILL.md. A sibling inherits it: there is
 *  no such thing as an editable file inside a read-only skill. */
function editableTier(tier: SkillAssetTier): boolean {
  return tier === 'user'
}

/** Absolute path of a sibling, or null if the relative path is not one the §2 rules allow.
 *  `assetPathError` is string-only and rejects `..`, absolutes, drive letters, backslashes,
 *  over-deep paths and SKILL.md itself — so this never needs its own containment check. */
function siblingPath(dir: string, relPath: string): string | null {
  if (assetPathError(relPath) !== null) return null
  return path.join(dir, ...relPath.split('/'))
}

function walk(dir: string, prefix: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) walk(path.join(dir, e.name), rel, out)
    else if (e.isFile() && assetPathError(rel) === null) out.push(rel)
  }
}

export function listSkillFiles(argusHome: string, skill: string): SkillFileEntry[] {
  const w = winner(argusHome, skill)
  if (!w) return []
  const rels: string[] = []
  walk(w.dir, '', rels)
  rels.sort()
  const editable = editableTier(w.tier)
  return rels.map((relPath) => {
    const abs = path.join(w.dir, ...relPath.split('/'))
    let content = ''
    try {
      content = fs.readFileSync(abs, 'utf8')
    } catch {
      // unreadable; report it as a non-executable empty file rather than dropping it silently
    }
    return {
      relPath,
      bytes: Buffer.byteLength(content, 'utf8'),
      executable: isExecutableAsset(relPath, content),
      tier: w.tier,
      editable
    }
  })
}

export function readSkillFile(
  argusHome: string,
  skill: string,
  relPath: string
): SkillFileRead | null {
  const w = winner(argusHome, skill)
  if (!w) return null
  const abs = siblingPath(w.dir, relPath)
  if (abs === null) return null
  let content: string
  try {
    if (!fs.statSync(abs).isFile()) return null
    content = fs.readFileSync(abs, 'utf8')
  } catch {
    return null
  }
  return {
    content,
    hash: sha256Hex(content),
    executable: isExecutableAsset(relPath, content),
    tier: w.tier,
    editable: editableTier(w.tier)
  }
}

/** Throws with a user-facing message on every refusal. The renderer disables what it can, but
 *  this is the boundary — a fourth independent gate beside `acceptProposal`, `LibraryPage`'s
 *  tier check and `assetEditable.ts`. */
function mutable(argusHome: string, skill: string): { dir: string; tier: SkillAssetTier } {
  const w = winner(argusHome, skill)
  if (!w) throw new Error(`No such skill: ${skill}`)
  if (!editableTier(w.tier)) {
    throw new Error(`"${skill}" is a ${w.tier} skill and is read-only. Edit a copy first.`)
  }
  return w
}

export function writeSkillFile(
  argusHome: string,
  skill: string,
  relPath: string,
  content: string,
  baseHash: string | null
): SkillFileWriteResult {
  const w = mutable(argusHome, skill)
  const bad = assetPathError(relPath)
  if (bad) throw new Error(bad)
  const abs = path.join(w.dir, ...relPath.split('/'))

  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_ASSET_FILE_BYTES) {
    throw new Error(
      `"${relPath}" is ${bytes} bytes; the limit is ${MAX_ASSET_FILE_BYTES} (64 KB) per file`
    )
  }

  const existing = listSkillFiles(argusHome, skill)
  // Case-insensitive (I4): Windows/macOS filesystems are case-insensitive, so `Scripts/Run.sh`
  // and an existing `scripts/run.sh` name the SAME file on disk. `assetValidation.ts`'s
  // REFERENCES_INDEX check is the in-repo precedent for this comparison. An exact-case compare
  // here let a differently-cased create silently OVERWRITE the existing file: `prior` came back
  // `undefined`, `onDisk` was never probed, and the `baseHash === null` "already exists" guard
  // below never fired.
  const prior = existing.find((f) => f.relPath.toLowerCase() === relPath.toLowerCase())

  // Optimistic concurrency, matching `writeUserSkill`'s baseHash contract: a null baseHash means
  // "I am creating this", so a file already there is a conflict, not an overwrite. `relPath`
  // (not `prior.relPath`) is what's read: the filesystem itself resolves the differently-cased
  // path to the same file, so this still returns the real on-disk content when `prior` matched
  // only case-insensitively.
  const onDisk = prior ? readSkillFile(argusHome, skill, relPath) : null
  if (baseHash === null && onDisk) throw new Error(`"${relPath}" already exists`)
  if (baseHash !== null && onDisk && onDisk.hash !== baseHash) {
    throw new Error(`"${relPath}" changed on disk since you opened it`)
  }
  // I5: a non-null baseHash means the caller opened an EXISTING file (a real tab, holding a
  // hash it read off disk) and is saving an edit to it — so the file being absent now means it
  // was renamed or deleted elsewhere since the tab opened, not that this is a create. Without
  // this, that combination fell through both guards above (`onDisk` is null either way) straight
  // to `fs.writeFileSync`, which RECREATES the file at the old path — after a rename the skill
  // then carries both paths, each with its own review row. Real tab migration on rename/delete is
  // a follow-up; this is the scoped mitigation.
  if (baseHash !== null && !onDisk) {
    throw new Error(`"${relPath}" was deleted or renamed since you opened it`)
  }

  // `!prior` would be case-insensitive here too (it's just `prior` from :159), but that's the
  // wrong signal for THIS check on a case-sensitive filesystem: `prior` can be truthy for a
  // same-named-but-different-case sibling that never collided on disk (`onDisk` came back null,
  // see :166), which is a genuine new file, not an overwrite. `onDisk` is the corrected signal —
  // it reflects whether this write actually lands on an existing file, so the file-count cap
  // can't be stepped over on a case-sensitive volume, while an overwrite on a case-insensitive
  // one (where `onDisk` is non-null) still correctly skips the cap.
  if (!onDisk && existing.length >= MAX_ASSET_FILES) {
    throw new Error(`a skill may carry at most ${MAX_ASSET_FILES} files`)
  }
  // Case-insensitive, matching `prior` at :159: on a case-insensitive filesystem the file being
  // overwritten may be listed under different casing than `relPath`, so an exact-case compare
  // here would fail to exclude it and double-count its bytes toward the total — which could
  // refuse a legitimate write near the 256 KB cap.
  const total =
    existing.reduce(
      (n, f) => (f.relPath.toLowerCase() === relPath.toLowerCase() ? n : n + f.bytes),
      0
    ) + bytes
  if (total > MAX_ASSET_TOTAL_BYTES) {
    throw new Error(
      `the files would total ${total} bytes; the limit is ${MAX_ASSET_TOTAL_BYTES} (256 KB)`
    )
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
  return { hash: sha256Hex(content), executable: isExecutableAsset(relPath, content) }
}

export function deleteSkillFile(argusHome: string, skill: string, relPath: string): void {
  const w = mutable(argusHome, skill)
  const abs = siblingPath(w.dir, relPath)
  if (abs === null) throw new Error(`Illegal path: ${relPath}`)
  fs.rmSync(abs, { force: true })
  // Prune the directory if this was its last file, so an empty `scripts/` does not linger.
  const parent = path.dirname(abs)
  if (parent !== w.dir) {
    try {
      if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent)
    } catch {
      // a non-empty or already-gone directory is fine
    }
  }
}

export function renameSkillFile(argusHome: string, skill: string, from: string, to: string): void {
  const w = mutable(argusHome, skill)
  const src = siblingPath(w.dir, from)
  if (src === null) throw new Error(`Illegal path: ${from}`)
  const badTo = assetPathError(to)
  if (badTo) throw new Error(badTo)
  const dst = path.join(w.dir, ...to.split('/'))
  if (fs.existsSync(dst)) throw new Error(`"${to}" already exists`)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.renameSync(src, dst)
}

export interface SkillFileSaveDeps {
  argusHome: string
  db: DatabaseSync
  /** `Identity.name`, not the identity object — matching what `acceptProposal` passes. */
  reviewedBy: string | null
}

/**
 * Write a sibling and, if it is executable, record that a human here approved these exact bytes
 * (spec §7.1 — "authoring is reviewing").
 *
 * The row is what increment 3's run gate reads: without it, the author's own script would prompt
 * as `unreviewed` the first time the agent ran it. The write happens first and can throw, so a
 * refused write never leaves a row claiming bytes that were never stored.
 */
export function saveSkillFile(
  deps: SkillFileSaveDeps,
  skill: string,
  relPath: string,
  content: string,
  baseHash: string | null
): SkillFileWriteResult {
  const result = writeSkillFile(deps.argusHome, skill, relPath, content, baseHash)
  if (result.executable) {
    recordAssetReviews(deps.db, skill, [{ relPath, content }], {
      origin: 'editor',
      reviewedBy: deps.reviewedBy
    })
  }
  return result
}

/**
 * Delete a sibling AND its review row (triage 3). `deleteSkillFile` itself stays a pure
 * filesystem function — the db work lives here beside `saveSkillFile`, through the same
 * `SkillFileSaveDeps` shape, rather than inventing a second db-threading convention.
 */
export function deleteSkillFileReviewed(
  deps: Pick<SkillFileSaveDeps, 'argusHome' | 'db'>,
  skill: string,
  relPath: string
): void {
  deleteSkillFile(deps.argusHome, skill, relPath)
  dropSkillAssetReview(deps.db, skill, relPath)
}

/**
 * Rename a sibling AND carry its review row to the new path (triage 3's other half). Without
 * this, a renamed executable sibling reads as `unreviewed` the moment the agent tries to run it,
 * even though the bytes at the new path are exactly what a human already approved at the old one.
 */
export function renameSkillFileReviewed(
  deps: Pick<SkillFileSaveDeps, 'argusHome' | 'db'>,
  skill: string,
  from: string,
  to: string
): void {
  renameSkillFile(deps.argusHome, skill, from, to)
  renameSkillAssetReview(deps.db, skill, from, to)
}
