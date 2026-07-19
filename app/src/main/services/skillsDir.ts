import fs from 'node:fs'
import path from 'node:path'
import { refTier } from './refSync/refFrontmatter'

export function sharedSkillsDir(argusHome: string): string {
  return path.join(argusHome, 'skills')
}
export function sharedReferencesDir(argusHome: string): string {
  return path.join(argusHome, 'references')
}

/**
 * Resolve the core-shipped skills asset dir — skills argus-core ships itself,
 * independent of any pack. Mirrors resolveSampleAssetsDir (onboarding.ts):
 * process.resourcesPath is set even in dev (pointing at Electron's OWN dist
 * resources), so existence-check the packaged path before trusting it and fall
 * back to the in-repo source dir otherwise.
 *
 * - Packaged: `<resourcesPath>/core-skills` (electron-builder extraResources).
 * - Dev / source: `<appRoot>/resources/core-skills`.
 */
export function resolveCoreSkillsDir(appRoot: string, resourcesPath?: string): string {
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, 'core-skills')
    if (fs.existsSync(packaged)) return packaged
  }
  return path.join(appRoot, 'resources', 'core-skills')
}

/** One skill name claimed by more than one seed source, in `seedSharedAssets` order. */
export interface SkillCollision {
  name: string
  /** Source dir whose copy survives (the last one — later sources overwrite earlier). */
  winner: string
  /** Earlier source dirs whose copy is overwritten, in source order. */
  shadowed: string[]
}

/**
 * Find skill names that more than one seed source provides.
 *
 * `seedSharedAssets` flat-copies every source into a single `skills/` dir, so on a name
 * collision the loser is gone from disk before `resolveSkills` ever scans — meaning
 * `ResolvedSkill.shadows` (which compares TIERS) structurally cannot report it, and a pack
 * silently losing a skill to another pack looks identical to never shipping one. Detection
 * therefore has to run against the sources, before the copy flattens them.
 *
 * Reports only; the winner is unchanged (later-wins is deliberate — core seeds after packs
 * so a pack cannot replace a core skill). Callers surface the result.
 */
export function detectSkillCollisions(sources: string[]): SkillCollision[] {
  const bySkill = new Map<string, string[]>()
  for (const src of sources) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(src, { withFileTypes: true })
    } catch {
      continue // missing source — seedSharedAssets skips these too
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (!fs.existsSync(path.join(src, e.name, 'SKILL.md'))) continue
      bySkill.set(e.name, [...(bySkill.get(e.name) ?? []), src])
    }
  }
  const out: SkillCollision[] = []
  for (const [name, dirs] of bySkill) {
    if (dirs.length < 2) continue
    out.push({ name, winner: dirs[dirs.length - 1], shadowed: dirs.slice(0, -1) })
  }
  return out
}

/** Tiers whose files were written after seeding (synced/authored) — never clobbered by a pack copy. */
const nonPackTiers = new Set(['confluence', 'user', 'team-knowledge', 'hivemind'])

export function isNonPackTiered(destFile: string): boolean {
  let stat: fs.Stats
  try {
    stat = fs.statSync(destFile)
  } catch {
    return false
  }
  if (!stat.isFile()) return false
  const tier = refTier(fs.readFileSync(destFile, 'utf8'))
  return tier !== null && nonPackTiers.has(tier)
}

/**
 * Seed the shared skills/ + references/ dirs from an ordered list of sources
 * (pack asset dirs first, optional env-override dir last — later sources
 * overwrite earlier on filename collision, extra files in the destination are
 * left alone). Reference files whose frontmatter carries a non-pack trust tier
 * (synced from Confluence, hivemind-installed, or user/team-authored) are never
 * overwritten — only untiered (pristine pack) copies are refreshed; skills are
 * always refreshed. Missing sources are skipped; a source that resolves to its
 * destination is skipped (argusHome may be the asset source itself in dev).
 */
export function seedSharedAssets(
  argusHome: string,
  sources: { skills: string[]; references: string[] }
): void {
  const keepTiered = (_src: string, destFile: string): boolean => !isNonPackTiered(destFile)
  for (const [srcs, dest, filter] of [
    [sources.skills, sharedSkillsDir(argusHome), undefined],
    [sources.references, sharedReferencesDir(argusHome), keepTiered]
  ] as const) {
    fs.mkdirSync(dest, { recursive: true })
    for (const src of srcs) {
      if (fs.existsSync(src) && path.resolve(src) !== path.resolve(dest)) {
        fs.cpSync(src, dest, { recursive: true, force: true, filter })
      }
    }
  }
}

export function updateClaudeMdWorkspaces(
  argusHome: string,
  caseSlug: string,
  workspaces: { path: string; branch: string | null }[]
): void {
  const file = path.join(argusHome, 'cases', caseSlug, 'CLAUDE.md')
  if (!fs.existsSync(file)) return
  const body =
    workspaces.length === 0
      ? '_No code workspaces linked._'
      : workspaces
          .map((w) => `- \`${w.path}\` (linked at branch \`${w.branch ?? '?'}\`)`)
          .join('\n')
  const content = fs.readFileSync(file, 'utf8')
  const replaced = content.replace(
    /<!-- argus:workspaces -->[\s\S]*?<!-- \/argus:workspaces -->/,
    `<!-- argus:workspaces -->\n${body}\n<!-- /argus:workspaces -->`
  )
  fs.writeFileSync(file, replaced)
}
