import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listProposals, listArchivedProposals, proposalBodyPath } from '../proposals'
import { proposalsDir, proposalsArchiveDir } from '../paths'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prop-shapes-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

/** Hand-built because nothing writes this shape until Task 3. */
function writeDirProposal(dir: string, name: string, fm: string, body: string): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true })
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\n${fm}\n---\n${body}`)
}

const PENDING_FM = [
  'type: skill-new',
  'target: collect-logs',
  'case: acme-1',
  'date: 2026-08-19T00:00:00.000Z',
  'title: Collect logs',
  'status: pending'
].join('\n')

describe('proposalBodyPath', () => {
  it('resolves a flat proposal to the file itself', () => {
    expect(proposalBodyPath('/p', 'a.md')).toBe(path.join('/p', 'a.md'))
  })

  it('resolves a directory proposal to its SKILL.md', () => {
    expect(proposalBodyPath('/p', 'a-dir')).toBe(path.join('/p', 'a-dir', 'SKILL.md'))
  })
})

describe('pending scan', () => {
  it('lists a directory-shaped pending proposal', () => {
    const dir = proposalsDir(home)
    writeDirProposal(dir, '2026-08-19-acme-1-collect-logs', PENDING_FM, '# body\n')
    const found = listProposals(home)
    expect(found).toHaveLength(1)
    expect(found[0].file).toBe('2026-08-19-acme-1-collect-logs')
    expect(found[0].target).toBe('collect-logs')
    expect(found[0].content).toContain('# body')
  })

  it('ignores a directory with no SKILL.md', () => {
    fs.mkdirSync(path.join(proposalsDir(home), 'not-a-proposal'), { recursive: true })
    expect(listProposals(home)).toHaveLength(0)
  })

  // A directory named `…​.md` reads as flat by name, so proposalBodyPath resolves it to the
  // directory itself and both accept and reject throw EISDIR — listing it would wedge the inbox
  // with an item that can be neither accepted nor rejected.
  it('refuses a directory whose name ends in .md, while a normal directory still lists', () => {
    const dir = proposalsDir(home)
    writeDirProposal(dir, 'seeded-wedge.md', PENDING_FM, 'wedge body\n')
    writeDirProposal(dir, 'seeded-ok', PENDING_FM, 'ok body\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(listProposals(home).map((p) => p.file)).toEqual(['seeded-ok'])
      expect(warn.mock.calls.flat().join(' ')).toContain('[proposals]')
    } finally {
      warn.mockRestore()
    }
  })

  it('still lists a flat proposal alongside a directory one', () => {
    const dir = proposalsDir(home)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'flat.md'), `---\n${PENDING_FM}\n---\nflat body\n`)
    writeDirProposal(dir, 'dir-one', PENDING_FM, 'dir body\n')
    expect(
      listProposals(home)
        .map((p) => p.file)
        .sort()
    ).toEqual(['dir-one', 'flat.md'])
  })
})

describe('archive scan', () => {
  it('lists a directory-shaped archived proposal', () => {
    const fm = PENDING_FM.replace('status: pending', 'status: rejected')
    writeDirProposal(proposalsArchiveDir(home), 'archived-dir', fm, 'body\n')
    const rows = listArchivedProposals(home)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ target: 'collect-logs', status: 'rejected' })
  })
})
