import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeProposal, listProposals, acceptProposal, rejectProposal } from '../proposals'
import { parseAuthorship } from '../../../shared/authorship'

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
      title: 'binlog triage recipe',
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

  it('accept re-validates target and refuses a hand-written traversal frontmatter', () => {
    // Bypass writeProposal's validation entirely: hand-write a proposal file whose
    // frontmatter target escapes proposals/ — defense-in-depth against anything else
    // that might one day write into proposals/ without going through writeProposal.
    const dir = path.join(home, 'proposals')
    fs.mkdirSync(dir, { recursive: true })
    const file = '2026-07-10-NAV-100-evil.md'
    fs.writeFileSync(
      path.join(dir, file),
      [
        '---',
        'type: skill-edit',
        'target: ../evil',
        'case: NAV-100',
        'date: 2026-07-10',
        'title: Evil',
        'status: pending',
        '---',
        '',
        '# pwned\n'
      ].join('\n')
    )

    expect(() => acceptProposal(home, file)).toThrow(/Invalid proposal target/)

    // nothing should have been written outside proposals/
    expect(fs.existsSync(path.join(home, 'evil'))).toBe(false)
    expect(fs.existsSync(path.join(home, 'skills-user', 'evil'))).toBe(false)
    // and the bad proposal is left untouched (not archived) since accept threw before archiving
    expect(fs.existsSync(path.join(dir, file))).toBe(true)
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

describe('rejectProposal reasons', () => {
  function writeOne(): string {
    return writeProposal(home, 'NAV-100', {
      type: 'skill-edit',
      target: 'rca',
      title: 'Sharpen step 4',
      content: '# rca v2\n'
    })
  }
  function archivedRaw(file: string): string {
    return fs.readFileSync(path.join(home, 'proposals', 'archive', file), 'utf8')
  }

  it('stamps reject_reason and a single-line capped reject_note', () => {
    const f = writeOne()
    rejectProposal(home, f, { tag: 'overgeneric', note: 'first line\nsecond line' })
    const raw = archivedRaw(f)
    expect(raw).toContain('status: rejected')
    expect(raw).toContain('reject_reason: overgeneric')
    expect(raw).toContain('reject_note: first line')
    expect(raw).not.toContain('second line')
  })

  it('reject without reason leaves frontmatter exactly as before', () => {
    const f = writeOne()
    rejectProposal(home, f)
    const raw = archivedRaw(f)
    expect(raw).toContain('status: rejected')
    expect(raw).not.toContain('reject_reason')
    expect(raw).not.toContain('reject_note')
  })

  it('throws on an invalid tag (IPC args are untyped at runtime)', () => {
    const f = writeOne()
    expect(() => rejectProposal(home, f, { tag: 'meh' as never })).toThrow(/Invalid reject reason/)
  })
})

describe('accept validates skill bodies', () => {
  it('refuses a skill proposal whose description is empty', () => {
    const file = writeProposal(home, 'case-1', {
      type: 'skill-new',
      target: 'hollow',
      title: 'Hollow skill',
      content: '---\nname: hollow\ndescription:\n---\n\n# hollow\nBody.'
    })
    expect(() => acceptProposal(home, file)).toThrow(/description/i)
    expect(fs.existsSync(path.join(home, 'skills-user', 'hollow'))).toBe(false)
  })

  it('refuses a skill proposal with no frontmatter at all — stamping name: adds a fence, so it now fails on the still-missing description instead', () => {
    // withFrontmatter unconditionally prepends a `---` fence when stamping the name in, so a
    // proposal that had NO frontmatter at all can no longer trip "Missing frontmatter" post-stamp
    // — it fails validateSkill's next rule instead (empty description). Still refused either way.
    const file = writeProposal(home, 'case-1', {
      type: 'skill-new',
      target: 'bare',
      title: 'Bare skill',
      content: '# bare\nBody.'
    })
    expect(() => acceptProposal(home, file)).toThrow(/description/i)
    expect(fs.existsSync(path.join(home, 'skills-user', 'bare'))).toBe(false)
  })

  it('still accepts a well-formed skill proposal', () => {
    const file = writeProposal(home, 'case-1', {
      type: 'skill-new',
      target: 'sound',
      title: 'Sound skill',
      content:
        '---\nname: sound\ndescription: Use when the body is well formed.\n---\n\n# sound\nBody.'
    })
    expect(acceptProposal(home, file)).toEqual({ kind: 'skill', name: 'sound' })
  })

  it('refuses a skill proposal with an empty body below the frontmatter', () => {
    const file = writeProposal(home, 'case-1', {
      type: 'skill-new',
      target: 'empty-body',
      title: 'Empty body',
      content: '---\ndescription: has a description but nothing else.\n---\n   \n'
    })
    expect(() => acceptProposal(home, file)).toThrow(/no body/i)
    expect(fs.existsSync(path.join(home, 'skills-user', 'empty-body'))).toBe(false)
  })

  it('accepts a proposal with no name: at all — stamping, not rejecting, the target', () => {
    // Agent output is never asked for frontmatter name (write_proposal's tool description
    // only demands full file content), so this is the realistic shape of a proposal.
    const file = writeProposal(home, 'case-1', {
      type: 'skill-new',
      target: 'unnamed',
      title: 'Unnamed skill',
      content: '---\ndescription: Use when nothing declares its own name.\n---\n\n# unnamed\nBody.'
    })
    expect(acceptProposal(home, file)).toEqual({ kind: 'skill', name: 'unnamed' })
    const written = fs.readFileSync(path.join(home, 'skills-user', 'unnamed', 'SKILL.md'), 'utf8')
    expect(written).toContain('name: unnamed')
  })

  it('corrects a proposal whose name: disagrees with the target, rather than refusing it', () => {
    const file = writeProposal(home, 'case-1', {
      type: 'skill-new',
      target: 'renamed',
      title: 'Wrong name',
      content:
        '---\nname: wrong\ndescription: Use when the declared name is stale.\n---\n\n# x\nBody.'
    })
    expect(acceptProposal(home, file)).toEqual({ kind: 'skill', name: 'renamed' })
    const written = fs.readFileSync(path.join(home, 'skills-user', 'renamed', 'SKILL.md'), 'utf8')
    expect(written).toContain('name: renamed')
    expect(written).not.toContain('name: wrong')
  })
})

describe('accept stamps authorship', () => {
  const me = { name: 'Jiawei Han', email: 'jiawiehan@gmail.com' }
  const now = new Date('2026-07-30T12:00:00Z')

  it('makes the accepter the author of a skill, marked as agent-drafted', () => {
    writeProposal(home, 'c1', {
      type: 'skill-new',
      target: 'my-skill',
      title: 't',
      content: '---\nname: my-skill\ndescription: d\n---\n# body\n'
    })
    const file = listProposals(home)[0].file
    acceptProposal(home, file, { identity: me, now })

    const raw = fs.readFileSync(path.join(home, 'skills-user', 'my-skill', 'SKILL.md'), 'utf8')
    const a = parseAuthorship(raw)
    expect(a.author).toBe('Jiawei Han <jiawiehan@gmail.com>')
    expect(a.origin).toBe('proposal')
    expect(a.contributors).toEqual([
      { name: 'Jiawei Han', email: 'jiawiehan@gmail.com', date: '2026-07-30' }
    ])
    expect(raw).toContain('description: d')
  })

  it('stamps an accepted reference without disturbing its tier', () => {
    writeProposal(home, 'c1', {
      type: 'reference-edit',
      target: 'topic',
      title: 't',
      content: '# topic\n\nbody\n'
    })
    const file = listProposals(home)[0].file
    acceptProposal(home, file, { identity: me, now })

    const raw = fs.readFileSync(path.join(home, 'references', 'topic.md'), 'utf8')
    expect(raw).toContain('trust_tier: team-knowledge')
    expect(parseAuthorship(raw).author).toBe('Jiawei Han <jiawiehan@gmail.com>')
  })

  it('writes no authorship keys when there is no identity', () => {
    writeProposal(home, 'c1', {
      type: 'skill-new',
      target: 'my-skill',
      title: 't',
      content: '---\nname: my-skill\ndescription: d\n---\n# body\n'
    })
    acceptProposal(home, listProposals(home)[0].file, { identity: null, now })

    const raw = fs.readFileSync(path.join(home, 'skills-user', 'my-skill', 'SKILL.md'), 'utf8')
    expect(raw).not.toContain('author:')
    expect(raw).not.toContain('contributors:')
  })
})
