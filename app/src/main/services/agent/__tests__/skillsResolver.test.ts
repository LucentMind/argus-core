import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  deleteUserSkill,
  materializeSessionSkills,
  readSkill,
  resolveSkills,
  writeUserSkill,
  forkSkill,
  userSkillShadowDiverged,
  frontmatterDescriptionAndAuthor,
  isBundledSkillName
} from '../skillsResolver'
import { contentHash } from '../../contentHash'
import { caseDir } from '../../paths'
import { agentAccessSchema, defaultAgentAccess } from '../../../../shared/agentAccess'
import { validateSkill, hasErrors } from '../../../../shared/assetValidation'
import { parseAuthorship } from '../../../../shared/authorship'

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

describe('author on resolveSkills', () => {
  it('carries the author through, null when absent', () => {
    const dir = path.join(argusHome, 'skills-user', 'my-skill')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: my-skill\ndescription: d\nauthor: Alex Chen <alex@example.test>\n---\nbody\n'
    )
    const bare = path.join(argusHome, 'skills-user', 'bare')
    fs.mkdirSync(bare, { recursive: true })
    fs.writeFileSync(path.join(bare, 'SKILL.md'), '---\nname: bare\ndescription: d\n---\nbody\n')

    const skills = resolveSkills(argusHome, defaultAgentAccess())
    expect(skills.find((s) => s.name === 'my-skill')!.author).toBe('Alex Chen <alex@example.test>')
    expect(skills.find((s) => s.name === 'bare')!.author).toBeNull()
  })
})

describe('frontmatterDescriptionAndAuthor', () => {
  it('returns both fields off a single frontmatter read', () => {
    const dir = path.join(argusHome, 'skills-user', 'my-skill')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: my-skill\ndescription: does a thing\nauthor: Alex Chen <alex@example.test>\n---\nbody\n'
    )
    expect(frontmatterDescriptionAndAuthor(dir)).toEqual({
      description: 'does a thing',
      author: 'Alex Chen <alex@example.test>'
    })
  })

  it('author is null when absent; description falls back to empty like frontmatterDescription', () => {
    const dir = path.join(argusHome, 'skills-user', 'bare')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: bare\ndescription: d\n---\nbody\n')
    expect(frontmatterDescriptionAndAuthor(dir)).toEqual({ description: 'd', author: null })
  })

  it('reads SKILL.md exactly once, not once per field', () => {
    const dir = path.join(argusHome, 'skills-user', 'once')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: once\ndescription: d\nauthor: A <a@example.test>\n---\nbody\n'
    )
    const file = path.join(dir, 'SKILL.md')
    const spy = vi.spyOn(fs, 'readFileSync')
    frontmatterDescriptionAndAuthor(dir)
    const reads = spy.mock.calls.filter((call) => call[0] === file)
    expect(reads).toHaveLength(1)
    spy.mockRestore()
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
    writeUserSkill(argusHome, 'fresh', body('fresh'), null, null)
    const s = resolveSkills(argusHome, defaultAgentAccess()).find((x) => x.name === 'fresh')
    expect(s?.tier).toBe('user')
    expect(s?.description).toBe('Use when testing fresh.')
  })

  it('refuses invalid content even though it arrived straight over IPC', () => {
    expect(() => writeUserSkill(argusHome, 'bad', '# no frontmatter\n', null, null)).toThrow(
      /frontmatter/i
    )
    expect(fs.existsSync(path.join(argusHome, 'skills-user', 'bad'))).toBe(false)
  })

  it('refuses a traversal name', () => {
    expect(() => writeUserSkill(argusHome, '../evil', body('evil'), null, null)).toThrow()
  })

  it('overwrites when the base hash matches the file on disk', () => {
    const before = readSkill(argusHome, 'rca')
    writeUserSkill(argusHome, 'rca', body('rca'), before.hash, null)
    expect(readSkill(argusHome, 'rca').content).toBe(body('rca'))
  })

  it('returns the new content hash, matching a fresh read — so a follow-up save is not stale', () => {
    const before = readSkill(argusHome, 'rca')
    const returned = writeUserSkill(argusHome, 'rca', body('rca'), before.hash, null)
    expect(returned).toBe(contentHash(body('rca')))
    expect(returned).toBe(readSkill(argusHome, 'rca').hash)
    // The whole point: a second write using the returned hash as baseHash must succeed,
    // instead of throwing "changed on disk" against the now-stale hash from the first read.
    expect(() => writeUserSkill(argusHome, 'rca', body('rca'), returned, null)).not.toThrow()
  })

  it('refuses when the file changed under the editor', () => {
    expect(() =>
      writeUserSkill(argusHome, 'rca', body('rca'), contentHash('something else'), null)
    ).toThrow(/changed on disk/i)
  })

  it('a null base hash against an existing file is a name collision, not a "changed on disk" conflict', () => {
    // baseHash null means the editor believes it is CREATING "rca" — a file already being
    // there means the name is taken, which is a different problem than a concurrent edit of
    // something the editor had open (and sends the user looking for a writer that isn't there).
    expect(() => writeUserSkill(argusHome, 'rca', body('rca'), null, null)).toThrow(
      /already exists/i
    )
  })

  it('refuses to create a new user skill whose name collides with a bundled one', () => {
    expect(() =>
      writeUserSkill(argusHome, 'analyze-applog', body('analyze-applog'), null, null)
    ).toThrow(/ships with a pack/i)
    expect(fs.existsSync(path.join(argusHome, 'skills-user', 'analyze-applog'))).toBe(false)
  })
})

describe('isBundledSkillName', () => {
  it('is false when a hivemind copy shadows the bundled name — hivemind wins precedence', () => {
    // "analyze-applog" exists in both skills/ (bundled) and skills-hivemind/, no user copy.
    addSkill(path.join(argusHome, 'skills-hivemind'), 'analyze-applog', 'hive applog')
    expect(isBundledSkillName(argusHome, 'analyze-applog')).toBe(false)
    // resolveSkills agrees: hivemind is the winning tier for this name.
    const resolved = resolveSkills(argusHome, defaultAgentAccess()).find(
      (s) => s.name === 'analyze-applog'
    )
    expect(resolved?.tier).toBe('hivemind')
  })

  it('is true for a bundled name with no user or hivemind copy', () => {
    expect(isBundledSkillName(argusHome, 'analyze-applog')).toBe(true)
  })

  it('is false for a name that is not bundled at all', () => {
    expect(isBundledSkillName(argusHome, 'no-such-skill')).toBe(false)
  })
})

describe('forkSkill', () => {
  it('refuses to fork a bundled (pack/core) skill', () => {
    expect(() => forkSkill(argusHome, 'analyze-applog', undefined, null)).toThrow(
      /ships with a pack/i
    )
    expect(fs.existsSync(path.join(argusHome, 'skills-user', 'analyze-applog'))).toBe(false)
  })

  it('copies a hivemind skill into the user tier so it shadows the pin', () => {
    addSkill(path.join(argusHome, 'skills-hivemind'), 'team-rca', 'hive rca')
    expect(forkSkill(argusHome, 'team-rca', undefined, null)).toBe('team-rca')
    const s = resolveSkills(argusHome, defaultAgentAccess()).find((x) => x.name === 'team-rca')
    expect(s?.tier).toBe('user')
    expect(s?.shadows).toEqual(['hivemind'])
  })

  it('copies non-SKILL.md files in the skill directory', () => {
    addSkill(path.join(argusHome, 'skills-hivemind'), 'hive-widget', 'hive widget')
    const src = path.join(argusHome, 'skills-hivemind', 'hive-widget', 'references')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'notes.md'), 'notes')
    forkSkill(argusHome, 'hive-widget', undefined, null)
    expect(
      fs.readFileSync(
        path.join(argusHome, 'skills-user', 'hive-widget', 'references', 'notes.md'),
        'utf8'
      )
    ).toBe('notes')
  })

  it('renames on request and rewrites the frontmatter name to match', () => {
    addSkill(path.join(argusHome, 'skills-hivemind'), 'hive-widget', 'hive widget')
    expect(forkSkill(argusHome, 'hive-widget', 'my-widget', null)).toBe('my-widget')
    const content = fs.readFileSync(
      path.join(argusHome, 'skills-user', 'my-widget', 'SKILL.md'),
      'utf8'
    )
    expect(content).toContain('name: my-widget')
    expect(hasErrors(validateSkill({ name: 'my-widget', content }))).toBe(false)
  })

  it('renames on request even when the source has no name: key at all', () => {
    const dir = path.join(argusHome, 'skills-hivemind', 'hive-widget')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\ndescription: hivemind widget, no name key\n---\n\n# hive-widget\n'
    )
    expect(forkSkill(argusHome, 'hive-widget', 'my-widget', null)).toBe('my-widget')
    const content = fs.readFileSync(
      path.join(argusHome, 'skills-user', 'my-widget', 'SKILL.md'),
      'utf8'
    )
    expect(content).toContain('name: my-widget')
    expect(hasErrors(validateSkill({ name: 'my-widget', content }))).toBe(false)
  })

  it('refuses when the target name already exists in the user tier', () => {
    addSkill(path.join(argusHome, 'skills-hivemind'), 'hive-widget', 'hive widget')
    expect(() => forkSkill(argusHome, 'hive-widget', 'rca', null)).toThrow(/already/i)
  })

  it('refuses a rename that would shadow a bundled skill name, even though the source is hivemind', () => {
    addSkill(path.join(argusHome, 'skills-hivemind'), 'hive-widget', 'hive widget')
    const bundledBefore = fs.readFileSync(
      path.join(argusHome, 'skills', 'analyze-applog', 'SKILL.md'),
      'utf8'
    )
    expect(() => forkSkill(argusHome, 'hive-widget', 'analyze-applog', null)).toThrow(
      /ships with a pack/i
    )
    // the bundled skill itself must be untouched...
    expect(
      fs.readFileSync(path.join(argusHome, 'skills', 'analyze-applog', 'SKILL.md'), 'utf8')
    ).toBe(bundledBefore)
    // ...and nothing must land under that name in skills-user.
    expect(fs.existsSync(path.join(argusHome, 'skills-user', 'analyze-applog'))).toBe(false)
  })

  it('refuses to fork a skill that already resolves at the user tier', () => {
    expect(() => forkSkill(argusHome, 'rca', undefined, null)).toThrow(/already yours/i)
  })
})

describe('authorship on write and fork', () => {
  const me = { name: 'Jiawei Han', email: 'jiawiehan@gmail.com' }
  const other = { name: 'Alex Chen', email: 'alex@example.test' }
  const skill = '---\nname: my-skill\ndescription: does a thing\n---\n# body\n'

  it('stamps a new user skill as hand-authored', () => {
    writeUserSkill(argusHome, 'my-skill', skill, null, me)
    const raw = fs.readFileSync(path.join(argusHome, 'skills-user', 'my-skill', 'SKILL.md'), 'utf8')
    const a = parseAuthorship(raw)
    expect(a.author).toBe('Jiawei Han <jiawiehan@gmail.com>')
    expect(a.origin).toBe('authored')
    expect(a.contributors).toHaveLength(1)
  })

  it('returns the hash of the STAMPED bytes so the next save is not a false conflict', () => {
    const hash = writeUserSkill(argusHome, 'my-skill', skill, null, me)
    // the editor adopts `hash` and saves again — this must not throw
    expect(() => writeUserSkill(argusHome, 'my-skill', `${skill}more\n`, hash, me)).not.toThrow()
  })

  it('a second engineer editing joins the contributors without taking the byline', () => {
    const hash = writeUserSkill(argusHome, 'my-skill', skill, null, me)
    const stamped = fs.readFileSync(
      path.join(argusHome, 'skills-user', 'my-skill', 'SKILL.md'),
      'utf8'
    )
    writeUserSkill(argusHome, 'my-skill', `${stamped}more\n`, hash, other)
    const a = parseAuthorship(
      fs.readFileSync(path.join(argusHome, 'skills-user', 'my-skill', 'SKILL.md'), 'utf8')
    )
    expect(a.author).toBe('Jiawei Han <jiawiehan@gmail.com>')
    expect(a.contributors.map((c) => c.email)).toEqual(['jiawiehan@gmail.com', 'alex@example.test'])
  })

  it('a saver who deleted the author: line from the buffer does not take the byline', () => {
    const hash = writeUserSkill(argusHome, 'my-skill', skill, null, me)
    const stamped = fs.readFileSync(
      path.join(argusHome, 'skills-user', 'my-skill', 'SKILL.md'),
      'utf8'
    )
    // exactly what the raw-frontmatter editor produces when a user deletes the byline
    const stripped = stamped.replace(/^author: .*\r?\n/m, '')
    expect(stripped).not.toContain('author:')
    writeUserSkill(argusHome, 'my-skill', stripped, hash, other)
    const a = parseAuthorship(
      fs.readFileSync(path.join(argusHome, 'skills-user', 'my-skill', 'SKILL.md'), 'utf8')
    )
    expect(a.author).toBe('Jiawei Han <jiawiehan@gmail.com>')
    expect(a.origin).toBe('authored')
    expect(a.contributors.map((c) => c.email)).toEqual(['jiawiehan@gmail.com', 'alex@example.test'])
  })

  it('a buffer claiming an author over an unauthored on-disk file does not win — absent on disk means nobody yet, not whatever the buffer says', () => {
    const unauthored = '---\nname: my-skill\ndescription: does a thing\n---\n# body\n'
    // no identity: written byte-for-byte, so the disk file genuinely carries no authorship keys
    const hash = writeUserSkill(argusHome, 'my-skill', unauthored, null, null)
    const spoofed =
      '---\nname: my-skill\ndescription: does a thing\nauthor: Someone Else <x@y.test>\norigin: authored\n---\n# rewritten\n'
    writeUserSkill(argusHome, 'my-skill', spoofed, hash, me)
    const a = parseAuthorship(
      fs.readFileSync(path.join(argusHome, 'skills-user', 'my-skill', 'SKILL.md'), 'utf8')
    )
    expect(a.author).toBe('Jiawei Han <jiawiehan@gmail.com>')
    expect(a.author).not.toContain('Someone Else')
  })

  it('an Improve-shaped buffer carrying no authorship at all keeps the on-disk trail', () => {
    // Improve replaces the whole file with a model's rewrite; nothing guarantees the model
    // carried the frontmatter stamp forward, and a lost `contributors:` block is unrecoverable.
    const seeded = [
      '---',
      'name: my-skill',
      'description: does a thing',
      'author: Alex Chen <alex@example.test>',
      'origin: proposal',
      'contributors:',
      '  - Alex Chen <alex@example.test> 2026-07-01',
      '  - Sam Doe <sam@example.test> 2026-07-02',
      '---',
      '# body\n'
    ].join('\n')
    const dir = path.join(argusHome, 'skills-user', 'my-skill')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), seeded)
    const hash = contentHash(seeded)

    writeUserSkill(argusHome, 'my-skill', skill, hash, me)
    const a = parseAuthorship(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'))
    expect(a.author).toBe('Alex Chen <alex@example.test>')
    expect(a.origin).toBe('proposal')
    expect(a.contributors.map((c) => c.email)).toEqual([
      'alex@example.test',
      'sam@example.test',
      'jiawiehan@gmail.com'
    ])
  })

  it('a fork preserves the original author and records the forker', () => {
    // seed a hivemind-tier skill authored by someone else
    const src = path.join(argusHome, 'skills-hivemind', 'their-skill')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(
      path.join(src, 'SKILL.md'),
      '---\nname: their-skill\ndescription: d\nauthor: Alex Chen <alex@example.test>\norigin: authored\n---\n# body\n'
    )
    forkSkill(argusHome, 'their-skill', undefined, me)
    const a = parseAuthorship(
      fs.readFileSync(path.join(argusHome, 'skills-user', 'their-skill', 'SKILL.md'), 'utf8')
    )
    expect(a.author).toBe('Alex Chen <alex@example.test>')
    expect(a.origin).toBe('fork')
    expect(a.contributors.map((c) => c.email)).toEqual(['jiawiehan@gmail.com'])
  })

  it('writes the file byte-for-byte unstamped when there is no identity', () => {
    writeUserSkill(argusHome, 'my-skill', skill, null, null)
    const raw = fs.readFileSync(path.join(argusHome, 'skills-user', 'my-skill', 'SKILL.md'), 'utf8')
    expect(raw).toBe(skill)
  })
})

describe('userSkillShadowDiverged', () => {
  it('is false when the two copies are byte-identical', () => {
    addSkill(path.join(argusHome, 'skills-hivemind'), 'probe', 'same')
    addSkill(path.join(argusHome, 'skills-user'), 'probe', 'same')
    expect(userSkillShadowDiverged(argusHome, 'probe')).toBe(false)
  })

  it('is true when the fork was edited', () => {
    addSkill(path.join(argusHome, 'skills-hivemind'), 'probe', 'upstream text')
    addSkill(path.join(argusHome, 'skills-user'), 'probe', 'my edited text')
    expect(userSkillShadowDiverged(argusHome, 'probe')).toBe(true)
  })

  it('is true when the fork adds a file the hive copy does not have', () => {
    addSkill(path.join(argusHome, 'skills-hivemind'), 'probe', 'same')
    addSkill(path.join(argusHome, 'skills-user'), 'probe', 'same')
    fs.writeFileSync(path.join(argusHome, 'skills-user', 'probe', 'extra.md'), 'extra\n')
    expect(userSkillShadowDiverged(argusHome, 'probe')).toBe(true)
  })

  it('ignores line-ending differences', () => {
    addSkill(path.join(argusHome, 'skills-hivemind'), 'probe', 'same')
    addSkillWithCRLF(path.join(argusHome, 'skills-user'), 'probe', 'same')
    expect(userSkillShadowDiverged(argusHome, 'probe')).toBe(false)
  })

  it('is false when there is no hivemind copy to shadow', () => {
    addSkill(path.join(argusHome, 'skills-user'), 'solo', 'mine')
    expect(userSkillShadowDiverged(argusHome, 'solo')).toBe(false)
  })
})
