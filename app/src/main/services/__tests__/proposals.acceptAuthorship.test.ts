import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeProposal, acceptProposal } from '../proposals'
import { userSkillsDir, hivemindSkillsDir } from '../paths'
import { sharedSkillsDir } from '../skillsDir'
import { parseAuthorship } from '../../../shared/authorship'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prop-authorship-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

const ACCEPTER = { name: 'Accepter Bot', email: 'accepter@example.com' }
const ORIGINAL_AUTHOR = 'Original Author <original@example.com>'
const CONTRIBUTOR_LINE = 'Earlier Contributor <earlier@example.com> 2026-01-01'

function skillBody(desc = 'Use when testing authorship merge.'): string {
  return `---\ndescription: ${desc}\n---\n\n# a-skill\nBody.\n`
}

/** A tiered copy of `a-skill` carrying an author and one contributor. */
function writeTieredSkill(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    [
      '---',
      'description: Use when testing authorship merge.',
      `author: ${ORIGINAL_AUTHOR}`,
      'origin: authored',
      'contributors:',
      `  - ${CONTRIBUTOR_LINE}`,
      '---',
      '',
      '# a-skill',
      'Body.',
      ''
    ].join('\n')
  )
}

function propose(target = 'a-skill', content = skillBody()): string {
  return writeProposal(home, 'agent-1', {
    type: 'skill-edit',
    target,
    title: 'Edit a-skill',
    content
  })
}

describe('acceptProposal skill authorship — reads the TIER WINNER, not just the user tier', () => {
  it('hivemind-tier: keeps the original author and contributor, adds the accepter as a contributor', () => {
    writeTieredSkill(path.join(hivemindSkillsDir(home), 'a-skill'))
    const f = propose()
    acceptProposal(home, f, { identity: ACCEPTER })
    const written = fs.readFileSync(path.join(userSkillsDir(home), 'a-skill', 'SKILL.md'), 'utf8')
    const authorship = parseAuthorship(written)
    expect(authorship.author).toBe(ORIGINAL_AUTHOR)
    expect(authorship.contributors.map((c) => c.email)).toEqual(
      expect.arrayContaining(['earlier@example.com', ACCEPTER.email])
    )
  })

  it('bundled/pack-tier: refuses the accept outright (targetLocked guard)', () => {
    writeTieredSkill(path.join(sharedSkillsDir(home), 'a-skill'))
    const f = propose()
    expect(() => acceptProposal(home, f, { identity: ACCEPTER })).toThrow(/pack/)
    // The refusal must land before any write — no shadow gets created.
    expect(fs.existsSync(path.join(userSkillsDir(home), 'a-skill'))).toBe(false)
  })

  it('brand-new skill (no copy in any tier) still stamps the accepter as author', () => {
    const f = writeProposal(home, 'agent-1', {
      type: 'skill-new',
      target: 'brand-new-skill',
      title: 'New skill',
      content: skillBody()
    })
    acceptProposal(home, f, { identity: ACCEPTER })
    const written = fs.readFileSync(
      path.join(userSkillsDir(home), 'brand-new-skill', 'SKILL.md'),
      'utf8'
    )
    const authorship = parseAuthorship(written)
    expect(authorship.author).toBe(`${ACCEPTER.name} <${ACCEPTER.email}>`)
    expect(authorship.contributors.map((c) => c.email)).toEqual([ACCEPTER.email])
  })

  it('a skill that already has a user-tier copy behaves exactly as before (regression guard)', () => {
    writeTieredSkill(path.join(userSkillsDir(home), 'a-skill'))
    const f = propose()
    acceptProposal(home, f, { identity: ACCEPTER })
    const written = fs.readFileSync(path.join(userSkillsDir(home), 'a-skill', 'SKILL.md'), 'utf8')
    const authorship = parseAuthorship(written)
    expect(authorship.author).toBe(ORIGINAL_AUTHOR)
    expect(authorship.contributors.map((c) => c.email)).toEqual(
      expect.arrayContaining(['earlier@example.com', ACCEPTER.email])
    )
  })
})
