import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// proposalCounts runs on every proposals:changed broadcast — during distill staging
// that is once per written file. It must stay frontmatter-cheap: resolving the skill
// tier winner (resolveSkills) per skill proposal made counting O(N²) in file reads.
vi.mock('../agent/skillsResolver', () => ({ resolveSkills: vi.fn(() => []) }))

import { resolveSkills } from '../agent/skillsResolver'
import { listProposals, proposalCounts, writeProposal } from '../proposals'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prop-counts-'))
  vi.mocked(resolveSkills).mockClear()
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('proposalCounts cheap path', () => {
  it('counts skill proposals without resolving skills', () => {
    writeProposal(home, 'c', { type: 'skill-edit', target: 'foo', title: 't', content: 'x' })
    writeProposal(home, 'c', { type: 'skill-new', target: 'bar', title: 't', content: 'x' })
    expect(proposalCounts(home)).toEqual({
      pendingCount: 2,
      byType: { 'skill-edit': 1, 'skill-new': 1 }
    })
    expect(resolveSkills).not.toHaveBeenCalled()

    // sanity: the full listing path is the one that pays for current-content resolution
    listProposals(home)
    expect(resolveSkills).toHaveBeenCalled()
  })

  it('skips non-proposal files exactly like listProposals', () => {
    writeProposal(home, 'c', { type: 'recipe', target: 'a', title: 't', content: 'x' })
    fs.writeFileSync(path.join(home, 'proposals', 'stray.txt'), 'not md')
    fs.writeFileSync(path.join(home, 'proposals', 'no-fm.md'), 'no frontmatter here')
    fs.writeFileSync(
      path.join(home, 'proposals', 'bad-type.md'),
      '---\ntype: bogus\ntarget: t\n---\nbody'
    )
    expect(proposalCounts(home)).toEqual({ pendingCount: 1, byType: { recipe: 1 } })
    expect(listProposals(home)).toHaveLength(1)
  })

  it('returns empty counts when the proposals dir does not exist', () => {
    expect(proposalCounts(home)).toEqual({ pendingCount: 0, byType: {} })
  })
})
