import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  deleteUserSkill,
  materializeSessionSkills,
  readSkill,
  resolveSkills,
  writeUserSkill,
  forkSkill
} from '../skillsResolver'
import { contentHash } from '../../contentHash'
import { caseDir } from '../../paths'
import { agentAccessSchema, defaultAgentAccess } from '../../../../shared/agentAccess'
import { validateSkill, hasErrors } from '../../../../shared/assetValidation'

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

describe('validator and resolver agree', () => {
  it('a validator-accepted skill resolves with the same description and roles', () => {
    const content = [
      '---',
      'name: agreed',
      'description: Use when the resolver and validator must not drift.',
      'roles:',
      '  - review',
      '  - triage',
      '---',
      '',
      '# agreed',
      'Body.'
    ].join('\n')
    expect(hasErrors(validateSkill({ name: 'agreed', content }))).toBe(false)

    const dir = path.join(argusHome, 'skills-user', 'agreed')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content)

    const resolved = resolveSkills(argusHome, defaultAgentAccess()).find((s) => s.name === 'agreed')
    expect(resolved?.description).toBe('Use when the resolver and validator must not drift.')
    expect(resolved?.roles).toEqual(['review', 'triage'])
  })
})

const body = (name: string): string =>
  [
    '---',
    `name: ${name}`,
    `description: Use when testing ${name}.`,
    '---',
    '',
    `# ${name}`,
    'Body.'
  ].join('\n')

describe('writeUserSkill', () => {
  it('writes a new user skill and it resolves at the user tier', () => {
    writeUserSkill(argusHome, 'fresh', body('fresh'), null)
    const s = resolveSkills(argusHome, defaultAgentAccess()).find((x) => x.name === 'fresh')
    expect(s?.tier).toBe('user')
    expect(s?.description).toBe('Use when testing fresh.')
  })

  it('refuses invalid content even though it arrived straight over IPC', () => {
    expect(() => writeUserSkill(argusHome, 'bad', '# no frontmatter\n', null)).toThrow(
      /frontmatter/i
    )
    expect(fs.existsSync(path.join(argusHome, 'skills-user', 'bad'))).toBe(false)
  })

  it('refuses a traversal name', () => {
    expect(() => writeUserSkill(argusHome, '../evil', body('evil'), null)).toThrow()
  })

  it('overwrites when the base hash matches the file on disk', () => {
    const before = readSkill(argusHome, 'rca')
    writeUserSkill(argusHome, 'rca', body('rca'), before.hash)
    expect(readSkill(argusHome, 'rca').content).toBe(body('rca'))
  })

  it('returns the new content hash, matching a fresh read — so a follow-up save is not stale', () => {
    const before = readSkill(argusHome, 'rca')
    const returned = writeUserSkill(argusHome, 'rca', body('rca'), before.hash)
    expect(returned).toBe(contentHash(body('rca')))
    expect(returned).toBe(readSkill(argusHome, 'rca').hash)
    // The whole point: a second write using the returned hash as baseHash must succeed,
    // instead of throwing "changed on disk" against the now-stale hash from the first read.
    expect(() => writeUserSkill(argusHome, 'rca', body('rca'), returned)).not.toThrow()
  })

  it('refuses when the file changed under the editor', () => {
    expect(() =>
      writeUserSkill(argusHome, 'rca', body('rca'), contentHash('something else'))
    ).toThrow(/changed on disk/i)
  })

  it('a null base hash against an existing file is a name collision, not a "changed on disk" conflict', () => {
    // baseHash null means the editor believes it is CREATING "rca" — a file already being
    // there means the name is taken, which is a different problem than a concurrent edit of
    // something the editor had open (and sends the user looking for a writer that isn't there).
    expect(() => writeUserSkill(argusHome, 'rca', body('rca'), null)).toThrow(/already exists/i)
  })
})

describe('forkSkill', () => {
  it('copies a bundled skill into the user tier so it shadows the pack', () => {
    expect(forkSkill(argusHome, 'analyze-applog')).toBe('analyze-applog')
    const s = resolveSkills(argusHome, defaultAgentAccess()).find(
      (x) => x.name === 'analyze-applog'
    )
    expect(s?.tier).toBe('user')
    expect(s?.shadows).toEqual(['bundled'])
  })

  it('copies a hivemind skill into the user tier so it shadows the pin', () => {
    addSkill(path.join(argusHome, 'skills-hivemind'), 'team-rca', 'hive rca')
    expect(forkSkill(argusHome, 'team-rca')).toBe('team-rca')
    const s = resolveSkills(argusHome, defaultAgentAccess()).find((x) => x.name === 'team-rca')
    expect(s?.tier).toBe('user')
    expect(s?.shadows).toEqual(['hivemind'])
  })

  it('copies non-SKILL.md files in the skill directory', () => {
    const src = path.join(argusHome, 'skills', 'analyze-applog', 'references')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'notes.md'), 'notes')
    forkSkill(argusHome, 'analyze-applog')
    expect(
      fs.readFileSync(
        path.join(argusHome, 'skills-user', 'analyze-applog', 'references', 'notes.md'),
        'utf8'
      )
    ).toBe('notes')
  })

  it('renames on request and rewrites the frontmatter name to match', () => {
    expect(forkSkill(argusHome, 'analyze-applog', 'my-applog')).toBe('my-applog')
    const content = fs.readFileSync(
      path.join(argusHome, 'skills-user', 'my-applog', 'SKILL.md'),
      'utf8'
    )
    expect(content).toContain('name: my-applog')
    expect(hasErrors(validateSkill({ name: 'my-applog', content }))).toBe(false)
  })

  it('renames on request even when the source has no name: key at all', () => {
    // The regex-replace this used to do (`raw.replace(/^name:\s*.+$/m, …)`) was a silent no-op
    // when there was no name: line to match — the fork would land under the OLD name with the
    // new folder, which is exactly the shape an accepted proposal can have pre-Fix-1-stamp.
    fs.writeFileSync(
      path.join(argusHome, 'skills', 'analyze-applog', 'SKILL.md'),
      '---\ndescription: bundled applog, no name key\n---\n\n# analyze-applog\n'
    )
    expect(forkSkill(argusHome, 'analyze-applog', 'my-applog')).toBe('my-applog')
    const content = fs.readFileSync(
      path.join(argusHome, 'skills-user', 'my-applog', 'SKILL.md'),
      'utf8'
    )
    expect(content).toContain('name: my-applog')
    expect(hasErrors(validateSkill({ name: 'my-applog', content }))).toBe(false)
  })

  it('refuses when the target name already exists in the user tier', () => {
    expect(() => forkSkill(argusHome, 'analyze-applog', 'rca')).toThrow(/already/i)
  })

  it('refuses to fork a skill that already resolves at the user tier', () => {
    expect(() => forkSkill(argusHome, 'rca')).toThrow(/already yours/i)
  })
})
