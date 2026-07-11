import fs from 'node:fs'
import path from 'node:path'
import { refTier } from './refSync/refFrontmatter'

export function sharedSkillsDir(argusHome: string): string {
  return path.join(argusHome, 'skills')
}
export function sharedReferencesDir(argusHome: string): string {
  return path.join(argusHome, 'references')
}

/** Tiers whose files were written after seeding (synced/authored) — never clobbered by a pack copy. */
const nonPackTiers = new Set(['confluence', 'user', 'team-knowledge', 'hivemind'])

function isNonPackTiered(destFile: string): boolean {
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
