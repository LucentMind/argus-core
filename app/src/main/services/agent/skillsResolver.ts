import fs from 'node:fs'
import path from 'node:path'
import { caseDir, hivemindSkillsDir, userSkillsDir } from '../paths'
import { sharedSkillsDir } from '../skillsDir'
import { skillEnabled, type AgentAccess } from '../../../shared/agentAccess'
import type { ModeRole } from '../../../shared/modes'

export type SkillTier = 'bundled' | 'user' | 'hivemind'

/**
 * Plugin name under which Argus's resolved skills are registered with the Claude CLI.
 *
 * Skill names are otherwise a flat global namespace, so an allowlist entry like
 * `contribute-back` matches EVERY skill of that name — including one shipped by a linked
 * code workspace (verified: one bare entry loaded two skills). Registering the case's
 * `.claude` dir as a local plugin qualifies ours as `argus:<name>`, which matches only
 * ours. See `qualifySkill` / `skillPluginRoot`.
 */
export const ARGUS_SKILL_PLUGIN = 'argus'

/** `<caseDir>/.claude` — a valid plugin root, since `<root>/skills/<name>` is already the
 *  junction layout `materializeSessionSkills` builds (and Copilot's skillDirectories reads). */
export function skillPluginRoot(caseDir: string): string {
  return path.join(caseDir, '.claude')
}

/** Bare resolved name → the plugin-qualified form an allowlist must use. */
export function qualifySkill(name: string): string {
  return `${ARGUS_SKILL_PLUGIN}:${name}`
}

export interface ResolvedSkill {
  name: string
  tier: SkillTier
  dir: string
  description: string
  enabled: boolean
  /** Lower-precedence tiers that also define this skill name. */
  shadows: SkillTier[]
  /** Mode roles this skill is tagged for (`roles:` frontmatter). Empty = universal. */
  roles: string[]
}

/** Precedence order, highest first (spec §1.4). */
const TIERS: Array<{ tier: SkillTier; root: (home: string) => string }> = [
  { tier: 'user', root: userSkillsDir },
  { tier: 'hivemind', root: hivemindSkillsDir },
  { tier: 'bundled', root: sharedSkillsDir }
]

/** Read `<skillDir>/SKILL.md` once and return just its `---`-fenced frontmatter body
 *  (or null if the file is missing/unreadable or has no frontmatter fence). Shared by
 *  `frontmatterDescription`/`frontmatterRoles` and by `resolveSkills`, which needs both
 *  fields but must not read the file twice per skill. */
function readFrontmatter(skillDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')
    return raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? null
  } catch {
    return null
  }
}

function parseDescription(fm: string | null): string {
  if (!fm) return ''
  const m = fm.match(/^description:\s*(.+)$/m)
  return m ? m[1].replace(/\r$/, '').trim() : ''
}

const stripQuotes = (s: string): string => s.trim().replace(/^["']|["']$/g, '')

/**
 * Parse the `roles:` frontmatter tag, supporting both YAML forms:
 *   inline: `roles: [review, triage]` / `roles: review, triage` / `roles: review` /
 *            `roles: "review"` / `roles: []`
 *   block:  `roles:\n  - review\n  - triage`
 *
 * The previous implementation used `/^roles:\s*(.+)$/m`, but `\s` matches newlines too, so
 * for the block form it consumed the line break after `roles:` and `(.+)` captured only the
 * first list item's raw text (`"- review"`) as a single mangled role — silently deranking
 * the skill in every mode. Scanning line-by-line (no `\s*` crossing a newline) avoids that.
 */
function parseRoles(fm: string | null): string[] {
  if (!fm) return []
  const lines = fm.split(/\r?\n/)
  const idx = lines.findIndex((l) => /^roles:\s*/.test(l))
  if (idx === -1) return []
  const inline = lines[idx].replace(/^roles:\s*/, '').trim()
  if (inline) {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(stripQuotes)
      .filter(Boolean)
  }
  // Block form: consume subsequent indented `- item` lines until one doesn't match.
  const items: string[] = []
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s+-\s*(.+)$/)
    if (!m) break
    items.push(stripQuotes(m[1]))
  }
  return items.filter(Boolean)
}

export function frontmatterDescription(skillDir: string): string {
  return parseDescription(readFrontmatter(skillDir))
}

export function frontmatterRoles(skillDir: string): string[] {
  return parseRoles(readFrontmatter(skillDir))
}

function scanTier(root: string): string[] {
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'SKILL.md')))
    .map((d) => d.name)
}

export function resolveSkills(argusHome: string, access: AgentAccess): ResolvedSkill[] {
  const byName = new Map<string, ResolvedSkill>()
  for (const { tier, root } of TIERS) {
    const tierRoot = root(argusHome)
    for (const name of scanTier(tierRoot)) {
      const existing = byName.get(name)
      if (existing) {
        existing.shadows.push(tier)
        continue
      }
      const dir = path.join(tierRoot, name)
      const fm = readFrontmatter(dir)
      byName.set(name, {
        name,
        tier,
        dir,
        description: parseDescription(fm),
        enabled: skillEnabled(access, `${tier}/${name}`),
        shadows: [],
        roles: parseRoles(fm)
      })
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Delete <argusHome>/skills-user/<name> — "adopt upstream" / remove a local
 * override so a lower-precedence tier (hivemind, bundled) wins resolution again.
 */
export function deleteUserSkill(argusHome: string, name: string): void {
  // path.basename only splits on '\' under win32 — reject it explicitly for parity
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw new Error(`Invalid skill name: ${name}`)
  }
  const dir = path.join(userSkillsDir(argusHome), name)
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
    throw new Error(`No user skill: ${name}`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

/** Read the tier-winning SKILL.md for the in-app viewer (same precedence as resolveSkills). */
export function readSkill(argusHome: string, name: string): { name: string; content: string } {
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw new Error(`Invalid skill name: ${name}`)
  }
  for (const { root } of TIERS) {
    const file = path.join(root(argusHome), name, 'SKILL.md')
    if (fs.existsSync(file)) return { name, content: fs.readFileSync(file, 'utf8') }
  }
  throw new Error(`No such skill: ${name}`)
}

/**
 * Rebuild <caseDir>/.claude/skills as per-skill junctions filtered by access, and write the
 * `.claude-plugin/plugin.json` that turns `<caseDir>/.claude` into a local plugin root.
 * Replaces the legacy whole-dir junction that caseService created for old cases.
 *
 * The manifest sits BESIDE `skills/`, not inside it, so the junction layout Copilot's
 * `skillDirectories` reads is untouched — only the Claude driver acts on the plugin.
 */
export function materializeSessionSkills(
  argusHome: string,
  caseSlug: string,
  access: AgentAccess
): ResolvedSkill[] {
  const pluginRoot = skillPluginRoot(caseDir(argusHome, caseSlug))
  const linkDir = path.join(pluginRoot, 'skills')
  fs.rmSync(linkDir, { recursive: true, force: true })
  fs.mkdirSync(linkDir, { recursive: true })
  const manifestDir = path.join(pluginRoot, '.claude-plugin')
  fs.mkdirSync(manifestDir, { recursive: true })
  fs.writeFileSync(
    path.join(manifestDir, 'plugin.json'),
    JSON.stringify(
      { name: ARGUS_SKILL_PLUGIN, description: 'Argus case skills', version: '1.0.0' },
      null,
      2
    )
  )
  const resolved = resolveSkills(argusHome, access)
  for (const s of resolved) {
    if (!s.enabled) continue
    fs.symlinkSync(s.dir, path.join(linkDir, s.name), 'junction')
  }
  return resolved
}

/** Order skills for a mode's role: role-matched + universal first (input order preserved),
 *  non-matching last. Ranks, never filters — every skill remains in the result. */
export function rankSkillsForMode(skills: ResolvedSkill[], role: ModeRole): ResolvedSkill[] {
  const applies = (s: ResolvedSkill): boolean => s.roles.length === 0 || s.roles.includes(role)
  return [...skills.filter(applies), ...skills.filter((s) => !applies(s))]
}
