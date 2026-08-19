import fs from 'node:fs'
import path from 'node:path'
import { hivemindSkillsDir, userSkillsDir } from '../paths'
import { sharedSkillsDir } from '../skillsDir'
import type { SkillAssetTier } from '../../../shared/skillAssets'

/** Which skill, in which tier, a file on disk belongs to. */
export interface SkillAssetId {
  tier: SkillAssetTier
  skill: string
  /** POSIX-separated, relative to the skill directory — the same spelling
   *  `skill_asset_reviews.rel_path` stores. */
  relPath: string
}

/** Same precedence order as `skillsResolver`'s TIERS: a user copy shadows hivemind, which
 *  shadows bundled. The order only matters if two roots ever nest, which they do not. */
const TIER_ROOTS: { tier: SkillAssetTier; root: (home: string) => string }[] = [
  { tier: 'user', root: userSkillsDir },
  { tier: 'hivemind', root: hivemindSkillsDir },
  { tier: 'bundled', root: sharedSkillsDir }
]

/** `realpathSync.native` on both sides, or nothing: it is what follows the per-case junction to
 *  the real tier root, and on Windows it also returns the filesystem's canonical casing, so the
 *  comparison below can be a plain one. Resolving only one side would compare a junction path
 *  against a real one and never match. Returns null when the path does not exist. */
function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return null
  }
}

/**
 * The skill asset an absolute path refers to, or null.
 *
 * A shell command in a case session sees `<caseDir>/.claude/skills/<name>/...`, which
 * `materializeSessionSkills` created as a junction to whichever tier root won — so this
 * resolves the real path first and matches THAT against the roots. Matching the literal path
 * would find nothing, and matching the junction's parent would report every skill as living in
 * the case directory.
 */
export function skillAssetAt(argusHome: string, absPath: string): SkillAssetId | null {
  const real = realOrNull(absPath)
  if (real === null) return null
  for (const { tier, root } of TIER_ROOTS) {
    const base = realOrNull(root(argusHome))
    if (base === null) continue
    const rel = path.relative(base, real)
    // `path.relative`, not `startsWith`: `skills-user-backup/` shares a prefix with
    // `skills-user/` and a string compare would claim it as a user-tier skill.
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue
    const parts = rel.split(path.sep)
    if (parts.length < 2) continue // the skill directory itself, not a file inside it
    return { tier, skill: parts[0], relPath: parts.slice(1).join('/') }
  }
  return null
}
