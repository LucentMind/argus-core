import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveSkills } from './skillsResolver'
import { defaultAgentAccess } from '../../../shared/agentAccess'
import { frontmatterOf, parseDescription } from '../../../shared/skillFrontmatter'
import { validateSkill, hasErrors } from '../../../shared/assetValidation'
import type { SkillImportSource, SkillImportCandidate } from '../../../shared/memoryIpc'

/** `<home>/.claude/skills` (global) or `<dir>/.claude/skills` (a project folder). */
function claudeSkillsDir(source: SkillImportSource): string {
  const base = source.kind === 'global' ? os.homedir() : source.dir
  if (!base) throw new Error('A project directory is required to scan a project source.')
  return path.join(base, '.claude', 'skills')
}

/** Classify one candidate skill directory found while scanning. Never throws: an unreadable or
 *  malformed SKILL.md becomes an 'invalid' row instead of aborting the whole scan. */
function classify(
  existingNames: ReadonlySet<string>,
  dir: string,
  name: string
): SkillImportCandidate {
  let content: string
  try {
    content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
  } catch (err) {
    return {
      name,
      sourceDir: dir,
      description: '',
      status: 'invalid',
      reason: `Could not read SKILL.md: ${(err as Error).message}`
    }
  }
  const description = parseDescription(frontmatterOf(content))
  const issues = validateSkill({ name, content })
  if (hasErrors(issues)) {
    return {
      name,
      sourceDir: dir,
      description,
      status: 'invalid',
      reason: issues.find((i) => i.severity === 'error')!.message
    }
  }
  if (existingNames.has(name)) {
    return {
      name,
      sourceDir: dir,
      description,
      status: 'conflict',
      reason: 'Already in your Library.'
    }
  }
  return { name, sourceDir: dir, description, status: 'importable' }
}

/**
 * List every candidate skill directory under a Claude skills folder (one level deep, matching
 * Argus's own `<tier>/<name>/SKILL.md` layout). Returns [] when the root doesn't exist — that is
 * the normal case for a user with no Claude skills, not an error.
 */
export function scanClaudeSkills(
  argusHome: string,
  source: SkillImportSource
): SkillImportCandidate[] {
  const root = claudeSkillsDir(source)
  if (!fs.existsSync(root)) return []
  const existingNames = new Set(resolveSkills(argusHome, defaultAgentAccess()).map((s) => s.name))
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => classify(existingNames, path.join(root, d.name), d.name))
    .sort((a, b) => a.name.localeCompare(b.name))
}
