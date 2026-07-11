import fs from 'node:fs'
import path from 'node:path'
import { caseDir, hivemindSkillsDir, userSkillsDir } from '../paths'
import { sharedSkillsDir } from '../skillsDir'
import { skillEnabled, type AgentAccess } from '../../../shared/agentAccess'

export type SkillTier = 'bundled' | 'user' | 'hivemind'

export interface ResolvedSkill {
  name: string
  tier: SkillTier
  dir: string
  description: string
  enabled: boolean
  /** Lower-precedence tiers that also define this skill name. */
  shadows: SkillTier[]
}

/** Precedence order, highest first (spec §1.4). */
const TIERS: Array<{ tier: SkillTier; root: (home: string) => string }> = [
  { tier: 'user', root: userSkillsDir },
  { tier: 'hivemind', root: hivemindSkillsDir },
  { tier: 'bundled', root: sharedSkillsDir }
]

export function frontmatterDescription(skillDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    const fmContent = fm?.[1]
    if (!fmContent) return ''
    const m = fmContent.match(/^description:\s*(.+)$/m)
    return m ? m[1].replace(/\r$/, '').trim() : ''
  } catch {
    return ''
  }
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
      byName.set(name, {
        name,
        tier,
        dir,
        description: frontmatterDescription(dir),
        enabled: skillEnabled(access, `${tier}/${name}`),
        shadows: []
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

/**
 * Rebuild <caseDir>/.claude/skills as per-skill junctions filtered by access.
 * Replaces the legacy whole-dir junction that caseService created for old cases.
 */
export function materializeSessionSkills(
  argusHome: string,
  caseSlug: string,
  access: AgentAccess
): void {
  const linkDir = path.join(caseDir(argusHome, caseSlug), '.claude', 'skills')
  fs.rmSync(linkDir, { recursive: true, force: true })
  fs.mkdirSync(linkDir, { recursive: true })
  for (const s of resolveSkills(argusHome, access)) {
    if (!s.enabled) continue
    fs.symlinkSync(s.dir, path.join(linkDir, s.name), 'junction')
  }
}
