import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanClaudeSkills, importSkills } from '../skillsImport'
import { userSkillsDir } from '../../paths'
import { parseAuthorship } from '../../../../shared/authorship'

let tmp: string, argusHome: string, claudeHome: string

function addClaudeSkill(
  root: string,
  name: string,
  description: string,
  extra?: Record<string, string>
): void {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
  )
  for (const [rel, content] of Object.entries(extra ?? {})) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-skimport-'))
  argusHome = path.join(tmp, 'home')
  claudeHome = path.join(tmp, 'claude-home')
  fs.mkdirSync(argusHome, { recursive: true })
  vi.spyOn(os, 'homedir').mockReturnValue(claudeHome)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('scanClaudeSkills', () => {
  it('returns [] when there is no .claude/skills directory', () => {
    expect(scanClaudeSkills(argusHome, { kind: 'global' })).toEqual([])
  })

  it('lists importable skills from the global ~/.claude/skills directory', () => {
    addClaudeSkill(path.join(claudeHome, '.claude', 'skills'), 'my-notes', 'Personal notes skill')
    const found = scanClaudeSkills(argusHome, { kind: 'global' })
    expect(found).toEqual([
      {
        name: 'my-notes',
        sourceDir: path.join(claudeHome, '.claude', 'skills', 'my-notes'),
        description: 'Personal notes skill',
        status: 'importable'
      }
    ])
  })

  it("scans a project folder's .claude/skills when kind is project", () => {
    const project = path.join(tmp, 'my-repo')
    addClaudeSkill(path.join(project, '.claude', 'skills'), 'proj-skill', 'Project-scoped skill')
    const found = scanClaudeSkills(argusHome, { kind: 'project', dir: project })
    expect(found.map((f) => f.name)).toEqual(['proj-skill'])
  })

  it('flags a name that already exists in the Argus Library as a conflict', () => {
    fs.mkdirSync(path.join(argusHome, 'skills-user', 'my-notes'), { recursive: true })
    fs.writeFileSync(
      path.join(argusHome, 'skills-user', 'my-notes', 'SKILL.md'),
      '---\nname: my-notes\ndescription: already here\n---\nbody\n'
    )
    addClaudeSkill(path.join(claudeHome, '.claude', 'skills'), 'my-notes', 'Personal notes skill')
    const found = scanClaudeSkills(argusHome, { kind: 'global' })
    expect(found[0]).toMatchObject({ name: 'my-notes', status: 'conflict' })
    expect(found[0].reason).toMatch(/already/i)
  })

  it('flags malformed SKILL.md as invalid without aborting the scan', () => {
    const skillsDir = path.join(claudeHome, '.claude', 'skills')
    fs.mkdirSync(path.join(skillsDir, 'broken'), { recursive: true })
    fs.writeFileSync(path.join(skillsDir, 'broken', 'SKILL.md'), '# no frontmatter\n')
    addClaudeSkill(skillsDir, 'good-skill', 'A fine skill')
    const found = scanClaudeSkills(argusHome, { kind: 'global' })
    expect(found.find((f) => f.name === 'broken')).toMatchObject({ status: 'invalid' })
    expect(found.find((f) => f.name === 'good-skill')).toMatchObject({ status: 'importable' })
  })

  it('flags a directory with no SKILL.md as invalid', () => {
    fs.mkdirSync(path.join(claudeHome, '.claude', 'skills', 'empty-dir'), { recursive: true })
    const found = scanClaudeSkills(argusHome, { kind: 'global' })
    expect(found).toEqual([expect.objectContaining({ name: 'empty-dir', status: 'invalid' })])
  })

  it('results are sorted by name', () => {
    const skillsDir = path.join(claudeHome, '.claude', 'skills')
    addClaudeSkill(skillsDir, 'zebra', 'z')
    addClaudeSkill(skillsDir, 'alpha', 'a')
    expect(scanClaudeSkills(argusHome, { kind: 'global' }).map((f) => f.name)).toEqual([
      'alpha',
      'zebra'
    ])
  })
})

describe('importSkills', () => {
  it('copies the whole skill directory, including sibling files, into skills-user', () => {
    const skillsDir = path.join(claudeHome, '.claude', 'skills')
    addClaudeSkill(skillsDir, 'my-notes', 'Personal notes skill', {
      'references/extra.md': 'extra content'
    })
    const results = importSkills(
      argusHome,
      [{ name: 'my-notes', sourceDir: path.join(skillsDir, 'my-notes') }],
      null
    )
    expect(results).toEqual([{ name: 'my-notes', ok: true }])
    expect(
      fs.readFileSync(path.join(userSkillsDir(argusHome), 'my-notes', 'SKILL.md'), 'utf8')
    ).toContain('Personal notes skill')
    expect(
      fs.readFileSync(
        path.join(userSkillsDir(argusHome), 'my-notes', 'references', 'extra.md'),
        'utf8'
      )
    ).toBe('extra content')
  })

  it('stamps imported skills with origin "import"', () => {
    const skillsDir = path.join(claudeHome, '.claude', 'skills')
    addClaudeSkill(skillsDir, 'my-notes', 'Personal notes skill')
    const me = { name: 'Jiawei Han', email: 'jiawiehan@gmail.com' }
    importSkills(argusHome, [{ name: 'my-notes', sourceDir: path.join(skillsDir, 'my-notes') }], me)
    const raw = fs.readFileSync(path.join(userSkillsDir(argusHome), 'my-notes', 'SKILL.md'), 'utf8')
    const a = parseAuthorship(raw)
    expect(a.origin).toBe('import')
    expect(a.author).toBe('Jiawei Han <jiawiehan@gmail.com>')
  })

  it('refuses a name that collides with a bundled skill, with the shared friendly message', () => {
    fs.mkdirSync(path.join(argusHome, 'skills', 'analyze-applog'), { recursive: true })
    fs.writeFileSync(
      path.join(argusHome, 'skills', 'analyze-applog', 'SKILL.md'),
      '---\nname: analyze-applog\ndescription: bundled\n---\nbody\n'
    )
    const skillsDir = path.join(claudeHome, '.claude', 'skills')
    addClaudeSkill(skillsDir, 'analyze-applog', 'a claude-side skill of the same name')
    const results = importSkills(
      argusHome,
      [{ name: 'analyze-applog', sourceDir: path.join(skillsDir, 'analyze-applog') }],
      null
    )
    expect(results).toEqual([
      { name: 'analyze-applog', ok: false, error: expect.stringContaining('ships with a pack') }
    ])
    expect(fs.existsSync(path.join(userSkillsDir(argusHome), 'analyze-applog'))).toBe(false)
  })

  it('re-validates against live state rather than trusting the scan snapshot', () => {
    const skillsDir = path.join(claudeHome, '.claude', 'skills')
    addClaudeSkill(skillsDir, 'my-notes', 'Personal notes skill')
    // simulate a name that appeared in skills-user after the scan ran but before apply
    fs.mkdirSync(path.join(argusHome, 'skills-user', 'my-notes'), { recursive: true })
    fs.writeFileSync(
      path.join(argusHome, 'skills-user', 'my-notes', 'SKILL.md'),
      '---\nname: my-notes\ndescription: raced\n---\nbody\n'
    )
    const results = importSkills(
      argusHome,
      [{ name: 'my-notes', sourceDir: path.join(skillsDir, 'my-notes') }],
      null
    )
    expect(results).toEqual([
      { name: 'my-notes', ok: false, error: expect.stringContaining('already exists') }
    ])
  })

  it('is best-effort: one failing item does not block the others', () => {
    const skillsDir = path.join(claudeHome, '.claude', 'skills')
    addClaudeSkill(skillsDir, 'good-one', 'A fine skill')
    const results = importSkills(
      argusHome,
      [
        { name: 'missing-one', sourceDir: path.join(skillsDir, 'missing-one') },
        { name: 'good-one', sourceDir: path.join(skillsDir, 'good-one') }
      ],
      null
    )
    expect(results[0].ok).toBe(false)
    expect(results[1]).toEqual({ name: 'good-one', ok: true })
    expect(fs.existsSync(path.join(userSkillsDir(argusHome), 'good-one'))).toBe(true)
  })

  it('refuses two selected items that resolve to the same name — only the first is imported', () => {
    const skillsDir = path.join(claudeHome, '.claude', 'skills')
    addClaudeSkill(skillsDir, 'dup', 'from global')
    const projectSkillsDir = path.join(tmp, 'my-repo', '.claude', 'skills')
    addClaudeSkill(projectSkillsDir, 'dup', 'from project')
    const results = importSkills(
      argusHome,
      [
        { name: 'dup', sourceDir: path.join(skillsDir, 'dup') },
        { name: 'dup', sourceDir: path.join(projectSkillsDir, 'dup') }
      ],
      null
    )
    expect(results[0]).toEqual({ name: 'dup', ok: true })
    expect(results[1].ok).toBe(false)
    expect(
      fs.readFileSync(path.join(userSkillsDir(argusHome), 'dup', 'SKILL.md'), 'utf8')
    ).toContain('from global')
  })

  it('refuses a sourceDir that is not shaped like a Claude skills directory', () => {
    const rogueDir = path.join(tmp, 'not-a-claude-skills-dir')
    fs.mkdirSync(rogueDir, { recursive: true })
    fs.writeFileSync(
      path.join(rogueDir, 'SKILL.md'),
      '---\nname: my-notes\ndescription: forged\n---\nbody\n'
    )
    const results = importSkills(argusHome, [{ name: 'my-notes', sourceDir: rogueDir }], null)
    expect(results).toEqual([
      { name: 'my-notes', ok: false, error: expect.stringContaining('not a Claude skills directory') }
    ])
    expect(fs.existsSync(path.join(userSkillsDir(argusHome), 'my-notes'))).toBe(false)
  })
})
