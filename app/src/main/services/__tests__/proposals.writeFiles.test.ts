import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeProposal, listProposals } from '../proposals'
import { proposalsDir } from '../paths'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prop-write-files-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

const base = {
  type: 'skill-new',
  target: 'collect-logs',
  title: 'Collect logs',
  content: '---\ndescription: collect logs\n---\n# Collect logs\n'
}

describe('writeProposal with files', () => {
  it('writes a directory carrying SKILL.md and each sibling', () => {
    const file = writeProposal(home, 'acme-1', {
      ...base,
      files: [
        { path: 'scripts/collect.sh', content: '#!/bin/sh\necho hi\n' },
        { path: 'templates/report.md', content: '# Report\n' }
      ]
    })
    expect(file.endsWith('.md')).toBe(false)
    const dir = path.join(proposalsDir(home), file)
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('# Collect logs')
    expect(fs.readFileSync(path.join(dir, 'scripts', 'collect.sh'), 'utf8')).toBe(
      '#!/bin/sh\necho hi\n'
    )
    expect(fs.readFileSync(path.join(dir, 'templates', 'report.md'), 'utf8')).toBe('# Report\n')
  })

  it('is listed as one proposal with the directory name as its key', () => {
    const file = writeProposal(home, 'acme-1', {
      ...base,
      files: [{ path: 'scripts/collect.sh', content: 'echo hi\n' }]
    })
    const found = listProposals(home)
    expect(found).toHaveLength(1)
    expect(found[0].file).toBe(file)
  })

  it('writes the flat shape when files is absent', () => {
    const file = writeProposal(home, 'acme-1', base)
    expect(file).toMatch(/^\d{4}-\d{2}-\d{2}-acme-1-collect-logs\.md$/)
    expect(fs.statSync(path.join(proposalsDir(home), file)).isFile()).toBe(true)
  })

  it('writes the flat shape when files is an empty array', () => {
    const file = writeProposal(home, 'acme-1', { ...base, files: [] })
    expect(fs.statSync(path.join(proposalsDir(home), file)).isFile()).toBe(true)
  })

  it('does not collide two directory proposals for the same target', () => {
    const a = writeProposal(home, 'acme-1', {
      ...base,
      files: [{ path: 'a.txt', content: '1' }]
    })
    const b = writeProposal(home, 'acme-1', {
      ...base,
      files: [{ path: 'a.txt', content: '2' }]
    })
    expect(b).not.toBe(a)
    expect(fs.readFileSync(path.join(proposalsDir(home), b, 'a.txt'), 'utf8')).toBe('2')
  })

  it('rejects files on a reference-edit', () => {
    expect(() =>
      writeProposal(home, 'acme-1', {
        type: 'reference-edit',
        target: 'notes',
        title: 'T',
        content: 'body',
        files: [{ path: 'a.txt', content: 'x' }]
      })
    ).toThrow(/skill-new|skill-edit/)
  })

  it('rejects a traversal path and writes nothing', () => {
    expect(() =>
      writeProposal(home, 'acme-1', {
        ...base,
        files: [{ path: '../evil.sh', content: 'x' }]
      })
    ).toThrow(/\.\./)
    expect(listProposals(home)).toHaveLength(0)
  })

  it('rejects an oversized file and writes nothing', () => {
    expect(() =>
      writeProposal(home, 'acme-1', {
        ...base,
        files: [{ path: 'big.txt', content: 'x'.repeat(65 * 1024) }]
      })
    ).toThrow(/big\.txt/)
    expect(listProposals(home)).toHaveLength(0)
  })

  it('strips a repeated .md suffix so a directory-shaped name never ends in .md', () => {
    const file = writeProposal(home, 'acme-1', {
      ...base,
      target: 'a.md.md',
      files: [{ path: 'a.txt', content: 'x' }]
    })
    expect(file.endsWith('.md')).toBe(false)
    expect(listProposals(home)).toHaveLength(1)
  })

  it('still ends in exactly one .md for the flat shape with the same repeated-suffix target', () => {
    // Parity with pre-multi-file behaviour: only a single `.md` strip, so `a.md.md` yields a
    // flat name of `a.md.md`, not `a.md`. Built from the date the write itself will use
    // (rather than a hard-coded literal) so the assertion still holds across a midnight
    // boundary.
    const date = new Date().toISOString().slice(0, 10)
    const file = writeProposal(home, 'acme-1', { ...base, target: 'a.md.md' })
    expect(file).toBe(`${date}-acme-1-a.md.md`)
  })
})
