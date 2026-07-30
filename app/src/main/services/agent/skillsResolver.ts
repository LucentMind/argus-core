import fs from 'node:fs'
import path from 'node:path'
import { caseDir, hivemindSkillsDir, userSkillsDir } from '../paths'
import { sharedSkillsDir } from '../skillsDir'
import { skillEnabled, defaultAgentAccess, type AgentAccess } from '../../../shared/agentAccess'
import type { ModeRole } from '../../../shared/modes'
import { frontmatterOf, parseDescription, parseRoles } from '../../../shared/skillFrontmatter'
import { contentHash } from '../contentHash'
import { validateSkill, hasErrors, ASSET_NAME_RE } from '../../../shared/assetValidation'
import { withFrontmatter } from '../frontmatter'

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
    return frontmatterOf(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'))
  } catch {
    return null
  }
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

/** Every file under `root`, as sorted `/`-joined relative paths. */
function fileListing(root: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(r)
      else if (e.isFile()) out.push(r)
    }
  }
  walk('')
  return out.sort()
}

/**
 * Does the user's fork of `name` differ from the installed HiveMind copy?
 *
 * Content-compared rather than stamped at fork time, because a shadow can also arrive via
 * proposal-accept (`proposals.ts` writes skill-edit straight to skills-user), which has no
 * fork event to record. Comparing live content also keeps the answer true after an Update
 * rewrites the hivemind copy — exactly where `updateAvailable` goes dark.
 *
 * NOT called from `resolveSkills`: that runs on every session materialization and must not
 * grow directory walks. `skillsPayload()` calls it for shadowing rows only.
 */
export function userSkillShadowDiverged(argusHome: string, name: string): boolean {
  const user = path.join(userSkillsDir(argusHome), name)
  const hive = path.join(hivemindSkillsDir(argusHome), name)
  try {
    if (!fs.existsSync(path.join(user, 'SKILL.md')) || !fs.existsSync(path.join(hive, 'SKILL.md')))
      return false
    const a = fileListing(user)
    const b = fileListing(hive)
    if (a.length !== b.length || a.some((f, i) => f !== b[i])) return true
    const read = (root: string, f: string): string =>
      fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n')
    return a.some((f) => read(user, f) !== read(hive, f))
  } catch {
    // A failed compare must not manufacture a scary chip.
    return false
  }
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
  assertSkillName(name)
  const dir = path.join(userSkillsDir(argusHome), name)
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
    throw new Error(`No user skill: ${name}`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

/** Read the tier-winning SKILL.md for the in-app viewer/editor (same precedence as resolveSkills). */
export function readSkill(
  argusHome: string,
  name: string
): { name: string; content: string; hash: string } {
  assertSkillName(name)
  for (const { root } of TIERS) {
    const file = path.join(root(argusHome), name, 'SKILL.md')
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8')
      return { name, content, hash: contentHash(content) }
    }
  }
  throw new Error(`No such skill: ${name}`)
}

/** path.basename only splits on '\' under win32 — reject it explicitly for parity. */
function assertSkillName(name: string): void {
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name) || !ASSET_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name: ${name}`)
  }
}

/**
 * Write `<argusHome>/skills-user/<name>/SKILL.md`.
 *
 * `baseHash` is the hash the editor received from `readSkill`; null means "I believe no file
 * exists". Either way it must describe what is on disk right now, or the write is refused —
 * proposal-accept writes this exact path, so a stale editor buffer really can clobber a
 * just-accepted proposal.
 *
 * Validation runs here, not only in the renderer: IPC is a trust boundary.
 *
 * Returns the hash of what was just written, so the caller can adopt it as the next
 * `baseHash` — the on-disk hash moves the instant this write lands, and a stale caller-side
 * hash would make the very next save fail with a misleading "changed on disk" conflict that
 * this write itself caused.
 */
export function writeUserSkill(
  argusHome: string,
  name: string,
  content: string,
  baseHash: string | null
): string {
  assertSkillName(name)
  const issues = validateSkill({ name, content })
  if (hasErrors(issues)) {
    throw new Error(issues.find((i) => i.severity === 'error')!.message)
  }
  const dir = path.join(userSkillsDir(argusHome), name)
  const file = path.join(dir, 'SKILL.md')
  const onDisk = fs.existsSync(file) ? contentHash(fs.readFileSync(file, 'utf8')) : null
  if (onDisk !== baseHash) {
    // baseHash null means the editor believes it is CREATING "name" — if a file is already
    // there, that's a name collision, not a concurrent edit of something the editor had open.
    if (baseHash === null && onDisk !== null) {
      throw new Error(`"${name}" already exists — choose a different name.`)
    }
    throw new Error(`"${name}" changed on disk since you opened it.`)
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, content)
  return contentHash(content)
}

/**
 * Copy the tier-winning copy of `name` into skills-user so it shadows the lower tier — the
 * skill-side equivalent of hivemind's `claimReference`, which has no skill counterpart.
 * `deleteUserSkill` ("Adopt upstream") is the undo.
 *
 * Copies the whole directory, not just SKILL.md: hivemind push already round-trips multi-file
 * skill dirs, so dropping sibling files here would lose content on a fork.
 */
export function forkSkill(argusHome: string, name: string, newName?: string): string {
  assertSkillName(name)
  const target = newName ?? name
  assertSkillName(target)
  const winner = resolveSkills(argusHome, defaultAgentAccess()).find((s) => s.name === name)
  if (!winner) throw new Error(`No such skill: ${name}`)
  if (winner.tier === 'user') throw new Error(`"${name}" is already yours.`)
  const dest = path.join(userSkillsDir(argusHome), target)
  if (fs.existsSync(dest)) throw new Error(`"${target}" already exists in your skills.`)
  fs.cpSync(winner.dir, dest, { recursive: true })
  if (target !== name) {
    const file = path.join(dest, 'SKILL.md')
    const raw = fs.readFileSync(file, 'utf8')
    // withFrontmatter, not a `name:` regex replace: the replace is a silent no-op when the
    // source has no name: key at all (the realistic shape of an accepted proposal, per the
    // proposals.ts accept-time stamp), which would land the fork under the wrong name.
    fs.writeFileSync(file, withFrontmatter(raw, { name: target }))
  }
  return target
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
