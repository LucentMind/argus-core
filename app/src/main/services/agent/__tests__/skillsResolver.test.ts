import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { materializeSessionSkills, resolveSkills } from '../skillsResolver'
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
  })
})
