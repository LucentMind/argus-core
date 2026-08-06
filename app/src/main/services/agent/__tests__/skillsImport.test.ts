import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanClaudeSkills } from '../skillsImport'

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
