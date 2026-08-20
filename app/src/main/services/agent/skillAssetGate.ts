import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  isExecutableAsset,
  type AssetReviewState,
  type SkillAssetTier
} from '../../../shared/skillAssets'
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
 * A single drive letter as the leading path segment, in the two spellings an MSYS path reaches
 * this module in:
 *
 * - `/c/Users/x` — what git-bash (and therefore the model writing a command for it) spells an
 *   absolute Windows path as. `skillAssetAt` can be handed this directly.
 * - `C:\c\Users\x` — what `path.resolve(caseDir, '/c/Users/x')` makes of it, which is what the
 *   token loop below passes: `path.resolve` reads the leading `/` as "root of the current drive",
 *   so the MSYS drive letter survives as a literal directory name.
 *
 * A SINGLE letter, deliberately: `/usr/bin/env` and `/config/x.sh` are not drive spellings.
 */
const MSYS_ROOTED = /^\/([A-Za-z])\/(.+)$/
const MSYS_DRIVE_MANGLED = /^[A-Za-z]:[\\/]([A-Za-z])[\\/](.+)$/

/**
 * The Windows path an MSYS-spelled path names, or null when the spelling does not apply.
 *
 * **win32 only.** On Linux and macOS `/c/Users/x` is a perfectly ordinary absolute path, and
 * rewriting it would point the gate at a file the command never named.
 */
function msysAltPath(p: string): string | null {
  if (process.platform !== 'win32') return null
  const m = MSYS_ROOTED.exec(p) ?? MSYS_DRIVE_MANGLED.exec(p)
  if (m === null) return null
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`
}

/**
 * `realOrNull`, plus the MSYS fallback — the resolution every path in this module goes through.
 *
 * The literal spelling is tried FIRST and the rewrite only when it names nothing: `C:\c\Users\…`
 * can legitimately exist (a directory called `c` at the drive root), and a real path must never
 * be shadowed by a speculative one. When the literal does resolve, its answer stands even if it
 * is not a skill asset — falling through would let a speculative path decide what a real one
 * already answered.
 *
 * Without this, the whole gate was dead for the git-bash spelling on Windows: `path.resolve`
 * produced `C:\c\…`, `realpathSync.native` threw ENOENT, and an unreviewed skill script ran with
 * no approval card at all (found by the live CDP run, 2026-08-20).
 */
function realOrNullMsysAware(p: string): string | null {
  const direct = realOrNull(p)
  if (direct !== null) return direct
  const alt = msysAltPath(p)
  return alt === null ? null : realOrNull(alt)
}

/** The tier roots that exist right now, resolved, highest precedence first. */
function tierRoots(argusHome: string): Array<{ tier: SkillAssetTier; root: string }> {
  const out: Array<{ tier: SkillAssetTier; root: string }> = []
  for (const { tier, root } of TIER_ROOTS) {
    const real = realOrNull(root(argusHome))
    if (real !== null) out.push({ tier, root: real })
  }
  return out
}

/** A matched asset together with the real path it resolved to — see `skillAssetAtRoots`. */
interface LocatedAsset {
  id: SkillAssetId
  /** The resolved, canonical path on disk. The caller must read the bytes from THIS and not from
   *  the path it passed in: for an MSYS spelling the two are different strings, and only this one
   *  exists. */
  real: string
}

/** `skillAssetAt` against roots the caller already resolved — see the note there. */
function skillAssetAtRoots(
  roots: ReadonlyArray<{ tier: SkillAssetTier; root: string }>,
  absPath: string
): LocatedAsset | null {
  const real = realOrNullMsysAware(absPath)
  if (real === null) return null
  for (const { tier, root } of roots) {
    const rel = path.relative(root, real)
    // `path.relative`, not `startsWith`: `skills-user-backup/` shares a prefix with
    // `skills-user/` and a string compare would claim it as a user-tier skill.
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue
    const parts = rel.split(path.sep)
    if (parts.length < 2) continue // the skill directory itself, not a file inside it
    return { id: { tier, skill: parts[0], relPath: parts.slice(1).join('/') }, real }
  }
  return null
}

/**
 * The skill asset an absolute path refers to, or null.
 *
 * A shell command in a case session sees `<caseDir>/.claude/skills/<name>/...`, which
 * `materializeSessionSkills` created as a junction to whichever tier root won — so this
 * resolves the real path first and matches THAT against the roots. Matching the literal path
 * would find nothing, and matching the junction's parent would report every skill as living in
 * the case directory.
 *
 * The tier roots are resolved once per call rather than once per tier inside the match loop.
 * `skillAssetContextForSegment` hoists them further — it resolves them once per SEGMENT and
 * calls `skillAssetAtRoots` per token — because `classifyToolCall` now runs the gate on every
 * shell command the agent issues, including through `onToolObserved` and `classifyOnly`, where
 * there is no approval card to pay for three realpath syscalls per token. Deliberately not a
 * process-lifetime cache keyed on `argusHome`: these roots are created and replaced at runtime
 * (pack install, "adopt upstream", a HiveMind pull), and a stale miss here reads as "not a skill
 * asset" — the unsafe direction.
 *
 * Both spellings of an absolute Windows path are accepted, `C:\…` and git-bash's `/c/…` — see
 * `realOrNullMsysAware`. The rewrite lives here rather than in the token loop below because
 * "which file does this path name" is this function's whole job, and every caller asks the same
 * question of a path the shell wrote; the loop's job is tokenizing and quote-stripping.
 */
export function skillAssetAt(argusHome: string, absPath: string): SkillAssetId | null {
  return skillAssetAtRoots(tierRoots(argusHome), absPath)?.id ?? null
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
  // A hard byte cut can land inside a multi-byte UTF-8 sequence. Decoding that half-sequence
  // with `.toString('utf8')` would not drop it — Node substitutes U+FFFD for the dangling
  // bytes, so the decoded body would be LONGER than what was actually kept, and the
  // bodyBytesTotal/bodyBytesOmitted counts a caller trusts would stop matching `body`. Walk
  // back from the cap to the start of the last complete sequence *before* decoding, so what we
  // decode is exactly what we kept, and derive the omitted count from that true kept length —
  // never from re-measuring the decoded string.
  let keep = SKILL_ASSET_BODY_CAP
  while (keep > 0 && (buf[keep] & 0xc0) === 0x80) keep-- // mid-sequence continuation byte
  return {
    body: buf.subarray(0, keep).toString('utf8'),
    bodyBytesTotal: buf.length,
    bodyBytesOmitted: buf.length - keep
  }
}

/**
 * `assetReviewState`, but total.
 *
 * Everything else this module touches is already inside a `try` — but the review lookup is a
 * `db.prepare(...).get(...)`, and this whole module hangs off `classifyToolCall`, which could
 * not throw before this gate existed. A SQLite error (a closed handle on shutdown, a migration
 * mid-flight) would otherwise propagate into `handleToolRequest` and `onToolObserved`.
 *
 * `'unreviewed'` is the conservative fallback: it makes the card say "never reviewed here", so
 * a failure produces MORE asking, never less.
 */
function reviewStateOrUnreviewed(
  db: DatabaseSync,
  skill: string,
  relPath: string,
  content: string
): AssetReviewState {
  try {
    return assetReviewState(db, skill, relPath, content)
  } catch {
    return 'unreviewed'
  }
}

/**
 * Whitespace-collapsed, trimmed — the spelling the grant key is taken over.
 *
 * Only incidental spacing is normalised away. Arguments, redirections and quoting all stay,
 * because they are exactly what the key exists to distinguish: `sh collect.sh` and
 * `sh collect.sh --purge /` must not share a session grant.
 *
 * KNOWN, accepted: the collapse does not respect quote boundaries, so `sh a.sh "foo   bar"` and
 * `sh a.sh "foo bar"` produce the same key and one grant covers both. Noted rather than fixed
 * (final review round 2, Minor) — telling the two apart needs a quote-aware tokenizer, and the
 * pair differs only in whitespace INSIDE one argument of an already-reviewed script.
 */
function normaliseSegment(segment: string): string {
  return segment.trim().replace(/\s+/g, ' ')
}

/**
 * The skill asset one shell segment would execute, with its review state — or null.
 *
 * **A gate, not a sandbox** (spec §7.4), stated here in the register `risk.ts` uses for PTC so
 * no future reader mistakes it for containment. This reads literal tokens, and the following
 * all slip past it and fall back to ordinary shell classification. The list is meant to be
 * exhaustive about what is known — an honest list is the whole value of this comment.
 *
 * - `bash "$(cat target)"`, a script piped to an interpreter on stdin, and any path the shell
 *   builds at run time. Recognising them would require executing the command's substitutions,
 *   which is the thing being gated.
 * - A command line nested inside one quoted token: `sh -c "bash .claude/skills/x/run.sh"`
 *   tokenizes to `sh`, `-c`, `"bash .claude/skills/x/run.sh"`, and the third token's stripped
 *   value is a whole command line, which `path.resolve` turns into a path that does not exist.
 *   Same for `xargs`, `env`, and `find -exec`.
 * - **A path containing a space.** `shellSegmentTokens` splits on `/\s+/`, so
 *   `bash "C:\Users\Jane Doe\.argus\skills-user\x\run.sh"` yields three tokens and none of them
 *   resolves. Skill names and relPaths are validated space-free, so the exposure is an absolute
 *   path under an `ARGUS_HOME` whose parent directory has a space in it — ordinary on Windows.
 *   This is a pre-existing property of the shared tokenizer (`cd "/outside dir"` already evades
 *   the sandbox deny in `risk.ts` the same way), but it is newly load-bearing here.
 * - **Path spellings other than `C:\…` and git-bash's `/c/…`.** Those two are handled
 *   (`realOrNullMsysAware`) because they are what Argus's own Windows shell produces; a live run
 *   showed the model reaching for `/c/…` unprompted and the gate missing it entirely. Still NOT
 *   recognised, because nothing Argus spawns emits them: Cygwin's `/cygdrive/c/…`, WSL's
 *   `/mnt/c/…`, the `\\?\C:\…` extended-length form, and UNC paths (`\\host\share\…`,
 *   `\\localhost\C$\…`) — a UNC path can name a file inside a tier root while resolving to a
 *   spelling that matches no local root.
 *
 * The first matching token wins: a command naming two skill scripts is gated on the first, and
 * approving it approves the whole segment either way. Across SEGMENTS the classifier handles it
 * instead — `classifyToolCall` refuses a grant key outright for any command with more than one
 * meaningful segment, which covers the two-script case and every other chained shape.
 *
 * `segmentKey` scopes the grant to this exact segment: the key `risk.ts` builds covers one
 * normalised command line, NOT the script in any context. Approving `sh collect.sh` grants
 * nothing to `sh collect.sh --purge /`.
 */
export function skillAssetContextForSegment(
  deps: SkillAssetGateDeps,
  segment: string
): SkillAssetContext | null {
  // `shellSegmentTokens` from risk.ts, deliberately: the gate and the classifier must never
  // disagree about which token is the program.
  const tokens = shellSegmentTokens(segment)
  if (tokens.length === 0) return null
  // Once per segment, not once per token — see `skillAssetAt`.
  const roots = tierRoots(deps.argusHome)
  if (roots.length === 0) return null
  for (const raw of tokens) {
    // Matched pair only, via the `\1` backreference — a malformed token like `'path"` keeps
    // its quotes rather than having both ends stripped independently. Harmless either way
    // (an unstripped token just fails to match a skill asset), but the matched form is the
    // honest read of "surrounding quotes".
    const token = raw.replace(/^(["'])(.*)\1$/, '$2')
    if (token === '' || token.startsWith('-')) continue
    const abs = path.resolve(deps.cwd, token)
    const located = skillAssetAtRoots(roots, abs)
    if (!located) continue
    const { id, real } = located
    let content: string
    try {
      // `real`, not `abs`: for an MSYS token `abs` is the `C:\c\…` mangling, which does not
      // exist. `real` is the same file in every other case, so this costs nothing.
      if (!fs.statSync(real).isFile()) continue
      // `utf8` string, then hash the string: `sha256Hex` digests a JS string as utf8, and
      // hashing raw bytes instead would disagree with every row increment 1 wrote.
      content = fs.readFileSync(real, 'utf8')
    } catch {
      continue
    }
    if (!isExecutableAsset(id.relPath, content)) continue
    return {
      skill: id.skill,
      tier: id.tier,
      relPath: id.relPath,
      hash: sha256Hex(content),
      segmentKey: sha256Hex(normaliseSegment(segment)),
      reviewState: reviewStateOrUnreviewed(deps.db, id.skill, id.relPath, content),
      ...capBody(content)
    }
  }
  return null
}
