import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeProposal, listProposals, acceptProposal, rejectProposal } from '../proposals'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prop-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

describe('writeProposal', () => {
  it('writes a pending frontmatter file and collision-suffixes', () => {
    const f1 = writeProposal(home, 'NAV-100', {
      type: 'skill-edit',
      target: 'rca',
      title: 'Sharpen step 4',
      content: '# rca v2\n'
    })
    const f2 = writeProposal(home, 'NAV-100', {
      type: 'skill-edit',
      target: 'rca',
      title: 'Sharpen step 4 again',
      content: '# rca v3\n'
    })
    expect(f1).not.toBe(f2)
    const raw = fs.readFileSync(path.join(home, 'proposals', f1), 'utf8')
    expect(raw).toContain('type: skill-edit')
    expect(raw).toContain('target: rca')
    expect(raw).toContain('case: NAV-100')
    expect(raw).toContain('status: pending')
    expect(raw.endsWith('# rca v2\n')).toBe(true)
  })

  it('refuses invalid types, targets, and empty content', () => {
    expect(() =>
      writeProposal(home, 'NAV-100', { type: 'nuke', target: 'rca', title: '', content: 'x' })
    ).toThrow(/Invalid proposal type/)
    expect(() =>
      writeProposal(home, 'NAV-100', {
        type: 'skill-edit',
        target: '../escape',
        title: '',
        content: 'x'
      })
    ).toThrow(/Invalid proposal target/)
    expect(() =>
      writeProposal(home, 'NAV-100', {
        type: 'recipe',
        target: 'recipes.md',
        title: '',
        content: '  '
      })
    ).toThrow(/content/)
  })
})

describe('listProposals', () => {
  it('lists pending proposals with current target content for diffing', () => {
    // a bundled skill the proposal edits
    fs.mkdirSync(path.join(home, 'skills', 'rca'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'skills', 'rca', 'SKILL.md'),
      '---\ndescription: old\n---\n# rca v1\n'
    )
    writeProposal(home, 'NAV-100', {
      type: 'skill-edit',
      target: 'rca',
      title: 'Sharpen',
      content: '# rca v2\n'
    })
    const [p] = listProposals(home).map((x) => x)
    expect(p.type).toBe('skill-edit')
    expect(p.current).toContain('# rca v1')
    expect(p.content).toBe('# rca v2\n')
  })

  it('returns null current when the target does not exist yet', () => {
    writeProposal(home, 'NAV-100', {
      type: 'skill-new',
      target: 'brand-new',
      title: 'New skill',
      content: '# new\n'
    })
    expect(listProposals(home)[0].current).toBeNull()
  })
})

describe('accept / reject', () => {
  it('accept applies a skill proposal to the USER tier (shadowing copy) and archives', () => {
    fs.mkdirSync(path.join(home, 'skills', 'rca'), { recursive: true })
    fs.writeFileSync(path.join(home, 'skills', 'rca', 'SKILL.md'), '# rca v1\n')
    const f = writeProposal(home, 'NAV-100', {
      type: 'skill-edit',
      target: 'rca',
      title: 'Sharpen',
      content: '---\ndescription: better\n---\n# rca v2\n'
    })
    acceptProposal(home, f)
    expect(fs.readFileSync(path.join(home, 'skills-user', 'rca', 'SKILL.md'), 'utf8')).toContain(
      '# rca v2'
    )
    // bundled copy untouched — user tier shadows it (§1.4 precedence)
    expect(fs.readFileSync(path.join(home, 'skills', 'rca', 'SKILL.md'), 'utf8')).toBe('# rca v1\n')
    expect(listProposals(home)).toEqual([])
    const archived = fs.readFileSync(path.join(home, 'proposals', 'archive', f), 'utf8')
    expect(archived).toContain('status: accepted')
  })

  it('accept stamps reference proposals team-knowledge in the references dir', () => {
    const f = writeProposal(home, 'NAV-100', {
      type: 'recipe',
      target: 'recipes.md',
      title: 'BINLOG triage recipe',
      content: '## Recipe\nsteps\n'
    })
    acceptProposal(home, f)
    const written = fs.readFileSync(path.join(home, 'references', 'recipes.md'), 'utf8')
    expect(written).toContain('trust_tier: team-knowledge')
    expect(written).toContain('## Recipe')
  })

  it('reject archives without applying', () => {
    const f = writeProposal(home, 'NAV-100', {
      type: 'skill-new',
      target: 'brand-new',
      title: 'New',
      content: '# new\n'
    })
    rejectProposal(home, f)
    expect(fs.existsSync(path.join(home, 'skills-user', 'brand-new'))).toBe(false)
    expect(fs.readFileSync(path.join(home, 'proposals', 'archive', f), 'utf8')).toContain(
      'status: rejected'
    )
  })

  it('unknown files throw', () => {
    expect(() => acceptProposal(home, 'nope.md')).toThrow(/Unknown proposal/)
    expect(() => rejectProposal(home, 'nope.md')).toThrow(/Unknown proposal/)
  })

  it('reject blocks path traversal to files outside proposals/', () => {
    // Create a decoy file outside proposals/ (in home root)
    const decoyPath = path.join(home, 'decoy.md')
    fs.writeFileSync(decoyPath, 'status: pending\n')
    expect(fs.existsSync(decoyPath)).toBe(true)

    // Attempt to reject via path traversal
    expect(() => rejectProposal(home, '../decoy.md')).toThrow(/Unknown proposal/)

    // Verify the decoy file was NOT deleted
    expect(fs.existsSync(decoyPath)).toBe(true)
  })
})
