import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  deleteUserSkill,
  materializeSessionSkills,
  readSkill,
  resolveSkills
} from '../skillsResolver'
import { caseDir } from '../../paths'
import { agentAccessSchema, defaultAgentAccess } from '../../../../shared/agentAccess'

let tmp: string, argusHome: string

function addSkill(root: string, name: string, description: string): void {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
  )
}

function addSkillWithCRLF(root: string, name: string, description: string): void {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${description}`, '---', '', `# ${name}`, ''].join('\r\n')
  )
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sk-'))
  argusHome = path.join(tmp, 'home')
  addSkill(path.join(argusHome, 'skills'), 'rca', 'bundled rca')
  addSkill(path.join(argusHome, 'skills'), 'analyze-applog', 'bundled applog')
  addSkill(path.join(argusHome, 'skills-user'), 'rca', 'user override rca')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('resolveSkills', () => {
  it('applies tier precedence user > bundled and reports shadowing', () => {
    const skills = resolveSkills(argusHome, defaultAgentAccess())
    const rca = skills.find((s) => s.name === 'rca')!
    expect(rca.tier).toBe('user')
    expect(rca.description).toBe('user override rca')
    expect(rca.shadows).toEqual(['bundled'])
    expect(skills.find((s) => s.name === 'analyze-applog')!.tier).toBe('bundled')
  })

  it('access disables by tier-qualified key on the winning tier', () => {
    const access = agentAccessSchema.parse({ skills: { 'user/rca': false } })
    const rca = resolveSkills(argusHome, access).find((s) => s.name === 'rca')!
    expect(rca.enabled).toBe(false)
  })

  it('parses frontmatter description from CRLF-line SKILL.md files', () => {
    addSkillWithCRLF(path.join(argusHome, 'skills'), 'crlf-test', 'crlf description')
    const skills = resolveSkills(argusHome, defaultAgentAccess())
    const crlfSkill = skills.find((s) => s.name === 'crlf-test')!
    expect(crlfSkill.description).toBe('crlf description')
  })
})

describe('deleteUserSkill', () => {
  it('removes the user-tier copy so the next tier wins resolution', () => {
    addSkill(path.join(argusHome, 'skills-hivemind'), 'rca', 'hivemind rca')
    let rca = resolveSkills(argusHome, defaultAgentAccess()).find((s) => s.name === 'rca')!
    expect(rca.tier).toBe('user')
    expect(rca.shadows).toEqual(['hivemind', 'bundled'])

    deleteUserSkill(argusHome, 'rca')

    expect(fs.existsSync(path.join(argusHome, 'skills-user', 'rca'))).toBe(false)
    rca = resolveSkills(argusHome, defaultAgentAccess()).find((s) => s.name === 'rca')!
    expect(rca.tier).toBe('hivemind')
    expect(rca.description).toBe('hivemind rca')
    expect(rca.shadows).toEqual(['bundled'])
  })

  it('throws when no user-tier skill of that name exists', () => {
    expect(() => deleteUserSkill(argusHome, 'analyze-applog')).toThrow(/No user skill/)
  })

  it('rejects names that escape the user skills dir', () => {
    // a sibling dir that a traversal name could reach
    addSkill(path.join(argusHome, 'skills'), 'victim', 'bundled victim')
    for (const evil of ['../skills/victim', '..\\skills\\victim', '..', '.', '']) {
      expect(() => deleteUserSkill(argusHome, evil)).toThrow(/Invalid skill name/)
    }
    expect(fs.existsSync(path.join(argusHome, 'skills', 'victim', 'SKILL.md'))).toBe(true)
  })
})

describe('materializeSessionSkills', () => {
  it('builds per-skill junctions for enabled winners only', () => {
    fs.mkdirSync(path.join(caseDir(argusHome, 'NAV-1'), '.claude'), { recursive: true })
    const access = agentAccessSchema.parse({ skills: { 'bundled/analyze-applog': false } })
    materializeSessionSkills(argusHome, 'NAV-1', access)
    const linkDir = path.join(caseDir(argusHome, 'NAV-1'), '.claude', 'skills')
    expect(fs.readdirSync(linkDir)).toEqual(['rca'])
    // the junction resolves to the user-tier dir
    const target = fs.readFileSync(path.join(linkDir, 'rca', 'SKILL.md'), 'utf8')
    expect(target).toContain('user override rca')
  })

  it('replaces a legacy whole-dir junction', () => {
    const claude = path.join(caseDir(argusHome, 'NAV-2'), '.claude')
    fs.mkdirSync(claude, { recursive: true })
    fs.symlinkSync(path.join(argusHome, 'skills'), path.join(claude, 'skills'), 'junction')
    materializeSessionSkills(argusHome, 'NAV-2', defaultAgentAccess())
    const entries = fs.readdirSync(path.join(claude, 'skills')).sort()
    expect(entries).toEqual(['analyze-applog', 'rca'])
    // rmSync must unlink the junction only, never delete through it — SHARED skills dir survives
    const sharedSkills = fs.readdirSync(path.join(argusHome, 'skills')).sort()
    expect(sharedSkills).toEqual(['analyze-applog', 'rca'])
  })

  it('returns the resolved skills so callers can reuse the scan', () => {
    const resolved = materializeSessionSkills(argusHome, 'NAV-3', defaultAgentAccess())
    expect(resolved.map((s) => s.name).sort()).toEqual(['analyze-applog', 'rca'])
    expect(resolved.find((s) => s.name === 'rca')!.tier).toBe('user')
  })
})

describe('readSkill', () => {
  it('returns the tier-winning SKILL.md content', () => {
    expect(readSkill(argusHome, 'rca').content).toContain('user override rca')
    expect(readSkill(argusHome, 'analyze-applog').content).toContain('bundled applog')
  })

  it('throws on unknown names and traversal attempts', () => {
    expect(() => readSkill(argusHome, 'nope')).toThrow(/No such skill/)
    for (const evil of ['../skills/rca', '..\\skills\\rca', '..', '.', '']) {
      expect(() => readSkill(argusHome, evil)).toThrow(/Invalid skill name/)
    }
  })
})
