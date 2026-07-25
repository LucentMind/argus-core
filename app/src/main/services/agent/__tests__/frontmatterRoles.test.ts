import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { frontmatterRoles } from '../skillsResolver'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-fm-roles-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Write a SKILL.md with the given frontmatter body (between the `---` fences) and return
 *  its directory, so frontmatterRoles can be exercised through the real file-reading path
 *  rather than against the regex in isolation. */
function writeSkill(frontmatterBody: string): string {
  const dir = path.join(tmp, 'skill')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatterBody}\n---\n\nBody text.\n`)
  return dir
}

describe('frontmatterRoles', () => {
  it.each([
    ['bracketed inline list', 'roles: [review, triage]', ['review', 'triage']],
    ['bare comma-separated inline list', 'roles: review, triage', ['review', 'triage']],
    ['single bare value', 'roles: review', ['review']],
    ['single quoted value', 'roles: "review"', ['review']],
    ['single-quoted value', "roles: 'review'", ['review']],
    ['empty bracket list', 'roles: []', []]
  ])('parses inline form: %s', (_label, frontmatter, expected) => {
    const dir = writeSkill(`description: test\n${frontmatter}`)
    expect(frontmatterRoles(dir)).toEqual(expected)
  })

  it('parses standard YAML block-list form', () => {
    const dir = writeSkill('description: test\nroles:\n  - review\n  - triage')
    expect(frontmatterRoles(dir)).toEqual(['review', 'triage'])
  })

  it('parses a block-list form with quoted items', () => {
    const dir = writeSkill('description: test\nroles:\n  - "review"\n  - \'triage\'')
    expect(frontmatterRoles(dir)).toEqual(['review', 'triage'])
  })

  it('returns [] when there is no roles key at all', () => {
    const dir = writeSkill('description: test')
    expect(frontmatterRoles(dir)).toEqual([])
  })

  it('returns [] when SKILL.md is missing', () => {
    expect(frontmatterRoles(path.join(tmp, 'nonexistent'))).toEqual([])
  })
})
