import fs from 'node:fs'
import path from 'node:path'
import type { SkillMeta } from '../../shared/types'

export function sharedSkillsDir(argusHome: string): string {
  return path.join(argusHome, 'skills')
}
export function sharedReferencesDir(argusHome: string): string {
  return path.join(argusHome, 'references')
}

/** Dev default: repo-root skills/ + references/ next to app/. Overridable via env. */
export function resolveAssetSource(appRoot: string): { skills: string; references: string } {
  return {
    skills: process.env.ARGUS_SKILLS_DIR ?? path.resolve(appRoot, '..', 'skills'),
    references: process.env.ARGUS_REFERENCES_DIR ?? path.resolve(appRoot, '..', 'references')
  }
}

export function seedSharedDirs(argusHome: string, source: { skills: string; references: string }): void {
  for (const [src, dest] of [
    [source.skills, sharedSkillsDir(argusHome)],
    [source.references, sharedReferencesDir(argusHome)]
  ] as const) {
    // argusHome may be the asset source itself (dev default ~/Argus == repo checkout)
    if (fs.existsSync(src) && path.resolve(src) !== path.resolve(dest)) {
      fs.cpSync(src, dest, { recursive: true, force: true })
    } else {
      fs.mkdirSync(dest, { recursive: true })
    }
  }
}

export function listSkills(argusHome: string): SkillMeta[] {
  const dir = sharedSkillsDir(argusHome)
  if (!fs.existsSync(dir)) return []
  const out: SkillMeta[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(dir, entry.name, 'SKILL.md')
    if (!fs.existsSync(file)) continue
    const head = fs.readFileSync(file, 'utf8').split('\n---')[0]
    const name = /^name:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? entry.name
    const description = /^description:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? ''
    out.push({ name, description })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
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
      : workspaces.map((w) => `- \`${w.path}\` (linked at branch \`${w.branch ?? '?'}\`)`).join('\n')
  const content = fs.readFileSync(file, 'utf8')
  const replaced = content.replace(
    /<!-- argus:workspaces -->[\s\S]*?<!-- \/argus:workspaces -->/,
    `<!-- argus:workspaces -->\n${body}\n<!-- /argus:workspaces -->`
  )
  fs.writeFileSync(file, replaced)
}
