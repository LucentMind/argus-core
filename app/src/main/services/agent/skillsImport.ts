import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isBundledSkillName, bundledSkillError, resolveSkills } from './skillsResolver'
import { defaultAgentAccess } from '../../../shared/agentAccess'
import { frontmatterOf, parseDescription } from '../../../shared/skillFrontmatter'
import { validateSkill, hasErrors, ASSET_NAME_RE } from '../../../shared/assetValidation'
import { stampAuthorship, type Identity } from '../../../shared/authorship'
import { userSkillsDir } from '../paths'
import type {
  SkillImportSource,
  SkillImportCandidate,
  SkillImportItem,
  SkillImportItemResult
} from '../../../shared/memoryIpc'

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

/** `scanClaudeSkills` only ever produces sourceDir values shaped `<root>/.claude/skills/<name>` —
 *  reject anything else before reading from or copying it, so `importSkills` can't be pointed at
 *  an arbitrary directory via a forged IPC payload. */
function looksLikeClaudeSkillsDir(sourceDir: string): boolean {
  const parent = path.basename(path.dirname(sourceDir))
  const grandparent = path.basename(path.dirname(path.dirname(sourceDir)))
  return parent === 'skills' && grandparent === '.claude'
}

/**
 * Copy the selected candidates into skills-user. Re-validates and re-checks name collisions
 * against live state (not the scan snapshot the renderer is holding, which may be stale by the
 * time the user confirms) and against items already imported earlier in this same call — two
 * selected items that resolve to the same name only the first may claim. Best-effort: one item's
 * failure does not stop the rest from being imported.
 */
export function importSkills(
  argusHome: string,
  items: SkillImportItem[],
  identity: Identity | null
): SkillImportItemResult[] {
  const results: SkillImportItemResult[] = []
  const existing = new Set(resolveSkills(argusHome, defaultAgentAccess()).map((s) => s.name))
  for (const { name, sourceDir } of items) {
    try {
      if (!ASSET_NAME_RE.test(name)) throw new Error(`"${name}" is not a legal skill name.`)
      if (isBundledSkillName(argusHome, name)) throw bundledSkillError(name)
      if (existing.has(name)) throw new Error(`"${name}" already exists in your Library.`)
      if (!looksLikeClaudeSkillsDir(sourceDir)) {
        throw new Error(`"${sourceDir}" is not a Claude skills directory.`)
      }
      const content = fs.readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf8')
      const issues = validateSkill({ name, content })
      if (hasErrors(issues)) throw new Error(issues.find((i) => i.severity === 'error')!.message)
      const dest = path.join(userSkillsDir(argusHome), name)
      fs.cpSync(sourceDir, dest, { recursive: true })
      const destFile = path.join(dest, 'SKILL.md')
      const stamped = stampAuthorship(fs.readFileSync(destFile, 'utf8'), {
        identity,
        origin: 'import',
        now: new Date()
      })
      fs.writeFileSync(destFile, stamped)
      existing.add(name)
      results.push({ name, ok: true })
    } catch (err) {
      results.push({ name, ok: false, error: (err as Error).message })
    }
  }
  return results
}
