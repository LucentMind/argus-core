import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { isExecutableAsset, type SkillAssetTier } from '../../../shared/skillAssets'
import type { SkillAssetContext } from '../../../shared/agent-events'
import { assetReviewState, sha256Hex } from '../skillAssetReviews'
import { shellSegmentTokens } from './risk'
import { TIERS } from './skillsResolver'

/** Which skill, in which tier, a file on disk belongs to. */
export interface SkillAssetId {
  tier: SkillAssetTier
  skill: string
  /** POSIX-separated, relative to the skill directory — the same spelling
   *  `skill_asset_reviews.rel_path` stores. */
  relPath: string
}

/** Reuses `skillsResolver`'s tier list rather than keeping a second copy: the gate must
 *  identify assets in exactly the tiers `resolveSkills` materializes, so the two can never
 *  be allowed to drift apart. */
const TIER_ROOTS = TIERS

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

export interface SkillAssetGateDeps {
  argusHome: string
  db: DatabaseSync
  /** What a relative token in the command resolves against — the case directory. */
  cwd: string
}

/** Head-only, deliberately: for a script the first lines are what a reviewer reads, and PTC's
 *  head+tail splice would present two disjoint fragments as one program. */
export const SKILL_ASSET_BODY_CAP = 16_000

function capBody(content: string): {
  body: string
  bodyBytesTotal: number
  bodyBytesOmitted: number
} {
  const buf = Buffer.from(content, 'utf8')
  if (buf.length <= SKILL_ASSET_BODY_CAP) {
    return { body: content, bodyBytesTotal: buf.length, bodyBytesOmitted: 0 }
  }
  return {
    body: buf.subarray(0, SKILL_ASSET_BODY_CAP).toString('utf8'),
    bodyBytesTotal: buf.length,
    bodyBytesOmitted: buf.length - SKILL_ASSET_BODY_CAP
  }
}

/**
 * The skill asset one shell segment would execute, with its review state — or null.
 *
 * **A gate, not a sandbox** (spec §7.4), stated here in the register `risk.ts` uses for PTC so
 * no future reader mistakes it for containment. This reads literal tokens: `bash "$(cat
 * target)"`, a script piped to an interpreter on stdin, and any path the shell builds at run
 * time are invisible to it and fall back to ordinary shell classification. Recognising them
 * would require executing the command's substitutions, which is the thing being gated.
 *
 * The first matching token wins: a command naming two skill scripts is gated on the first, and
 * approving it approves the whole segment either way.
 */
export function skillAssetContextForSegment(
  deps: SkillAssetGateDeps,
  segment: string
): SkillAssetContext | null {
  // `shellSegmentTokens` from risk.ts, deliberately: the gate and the classifier must never
  // disagree about which token is the program.
  const tokens = shellSegmentTokens(segment)
  for (const raw of tokens) {
    const token = raw.replace(/^["']|["']$/g, '')
    if (token === '' || token.startsWith('-')) continue
    const abs = path.resolve(deps.cwd, token)
    const id = skillAssetAt(deps.argusHome, abs)
    if (!id) continue
    let content: string
    try {
      if (!fs.statSync(abs).isFile()) continue
      // `utf8` string, then hash the string: `sha256Hex` digests a JS string as utf8, and
      // hashing raw bytes instead would disagree with every row increment 1 wrote.
      content = fs.readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    if (!isExecutableAsset(id.relPath, content)) continue
    return {
      skill: id.skill,
      tier: id.tier,
      relPath: id.relPath,
      hash: sha256Hex(content),
      reviewState: assetReviewState(deps.db, id.skill, id.relPath, content),
      ...capBody(content)
    }
  }
  return null
}
