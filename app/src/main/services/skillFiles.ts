import fs from 'node:fs'
import path from 'node:path'
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
import { sha256Hex } from './skillAssetReviews'
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
  const prior = existing.find((f) => f.relPath === relPath)

  // Optimistic concurrency, matching `writeUserSkill`'s baseHash contract: a null baseHash means
  // "I am creating this", so a file already there is a conflict, not an overwrite.
  const onDisk = prior ? readSkillFile(argusHome, skill, relPath) : null
  if (baseHash === null && onDisk) throw new Error(`"${relPath}" already exists`)
  if (baseHash !== null && onDisk && onDisk.hash !== baseHash) {
    throw new Error(`"${relPath}" changed on disk since you opened it`)
  }

  if (!prior && existing.length >= MAX_ASSET_FILES) {
    throw new Error(`a skill may carry at most ${MAX_ASSET_FILES} files`)
  }
  const total = existing.reduce((n, f) => (f.relPath === relPath ? n : n + f.bytes), 0) + bytes
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
