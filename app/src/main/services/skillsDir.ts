import fs from 'node:fs'
import path from 'node:path'
import { refTier } from './refSync/refFrontmatter'
import { withFrontmatter } from '../../shared/frontmatter'
import { NON_PACK_TIERS } from '../../shared/trustTiers'

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
const nonPackTiers = new Set<string>(NON_PACK_TIERS)

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
  const skillsDest = sharedSkillsDir(argusHome)
  fs.mkdirSync(skillsDest, { recursive: true })
  for (const src of sources.skills) {
    if (fs.existsSync(src) && path.resolve(src) !== path.resolve(skillsDest)) {
      fs.cpSync(src, skillsDest, { recursive: true, force: true })
    }
  }

  const refsDest = sharedReferencesDir(argusHome)
  fs.mkdirSync(refsDest, { recursive: true })
  for (const src of sources.references) {
    if (fs.existsSync(src) && path.resolve(src) !== path.resolve(refsDest)) {
      seedReferenceTree(src, refsDest)
    }
  }
}

/**
 * Copy one reference seed source, stamping every markdown file `trust_tier: bundled`.
 *
 * A plain `cpSync` is not enough, because the stamp is the whole point. Seeded references used to
 * land UNTAGGED, and an untagged reference is treated as hand-authored: the writer stamps it
 * `trust_tier: user` on save (`ReferenceSyncService.writeReference`) and the editor lets you type
 * into it. So a bundled doc could be edited, silently become yours on first save — which also
 * detaches it from re-seeding, since `isNonPackTiered` then protects it — and then be
 * *permanently* deleted, with nothing left to restore it. Stamping here makes "bundled" a fact
 * about the file rather than an inference from where it happens to sit, and it backfills existing
 * homes for free: their untagged copies are untiered, so this refresh rewrites them stamped.
 *
 * `bundled` is deliberately NOT in `NON_PACK_TIERS`, so a stamped copy is still refreshed by the
 * next seed and still reaped when its pack is uninstalled. Only the tiers that mean "someone took
 * ownership" are skipped.
 *
 * Recursive because references nest (see `listReferenceFiles`' walk); a flat pass would leave a
 * whole subtree untagged. Non-markdown files are copied byte-for-byte — frontmatter is a markdown
 * convention, and reading an image through a utf8 round trip would corrupt it.
 */
function seedReferenceTree(src: string, dest: string): void {
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name)
    const to = path.join(dest, ent.name)
    if (ent.isDirectory()) {
      fs.mkdirSync(to, { recursive: true })
      seedReferenceTree(from, to)
      continue
    }
    if (!ent.isFile()) continue
    if (isNonPackTiered(to)) continue
    if (!ent.name.endsWith('.md')) {
      fs.copyFileSync(from, to)
      continue
    }
    fs.writeFileSync(to, withFrontmatter(fs.readFileSync(from, 'utf8'), { trust_tier: 'bundled' }))
  }
}

/**
 * The bound pull requests, written into their own marker region below the workspaces one.
 *
 * A separate region rather than extra lines inside `argus:workspaces`: that region is
 * rewritten by `writeStored` on every repo link/unlink, which knows nothing about PRs and
 * would erase them — and teaching it would put workspaces.ts and prBindings.ts in a
 * module cycle. Independent regions have independent writers.
 *
 * Cases created before this region existed have no markers, so the section is appended
 * on first write.
 */
export function updateClaudeMdPrs(
  argusHome: string,
  caseSlug: string,
  prs: { owner: string; repo: string; number: number; url: string; worktreePath: string | null }[]
): void {
  const file = path.join(argusHome, 'cases', caseSlug, 'CLAUDE.md')
  if (!fs.existsSync(file)) return
  const body =
    prs.length === 0
      ? '_No pull requests linked._'
      : prs
          .map((p) =>
            p.worktreePath
              ? `- \`${p.owner}/${p.repo}#${p.number}\` (${p.url}) — checked out at \`${p.worktreePath}\``
              : `- \`${p.owner}/${p.repo}#${p.number}\` (${p.url}) — not checked out locally; use \`gh pr diff ${p.number} --repo ${p.owner}/${p.repo}\``
          )
          .join('\n')
  const region = `<!-- argus:prs -->\n${body}\n<!-- /argus:prs -->`
  const content = fs.readFileSync(file, 'utf8')
  const replaced = /<!-- argus:prs -->[\s\S]*?<!-- \/argus:prs -->/.test(content)
    ? content.replace(/<!-- argus:prs -->[\s\S]*?<!-- \/argus:prs -->/, region)
    : content.replace(/(<!-- \/argus:workspaces -->)/, `$1\n\n## Linked pull requests\n\n${region}`)
  fs.writeFileSync(file, replaced)
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
