import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  writeProposal,
  rejectProposal,
  removePendingProposal,
  listProposals,
  listArchivedProposals
} from '../proposals'
import { proposalsDir, proposalsArchiveDir } from '../paths'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prop-archive-dir-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

function dirProposal(): string {
  return writeProposal(home, 'acme-1', {
    type: 'skill-new',
    target: 'collect-logs',
    title: 'Collect logs',
    content: '---\ndescription: collect logs\n---\n# Collect logs\n',
    files: [{ path: 'scripts/collect.sh', content: '#!/bin/sh\necho hi\n' }]
  })
}

describe('rejecting a directory-shaped proposal', () => {
  it('moves the whole directory into the archive, siblings included', () => {
    const file = dirProposal()
    rejectProposal(home, file, { tag: 'wrong' })
    expect(fs.existsSync(path.join(proposalsDir(home), file))).toBe(false)
    const archived = path.join(proposalsArchiveDir(home), file)
    expect(fs.readFileSync(path.join(archived, 'scripts', 'collect.sh'), 'utf8')).toContain('echo hi')
    expect(fs.readFileSync(path.join(archived, 'SKILL.md'), 'utf8')).toContain('status: rejected')
  })

  it('is visible to listArchivedProposals with its reject reason — the §1 invariant', () => {
    const file = dirProposal()
    rejectProposal(home, file, { tag: 'wrong', note: 'not reusable' })
    const rows = listArchivedProposals(home)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      target: 'collect-logs',
      status: 'rejected',
      rejectReason: 'wrong',
      rejectNote: 'not reusable'
    })
  })
})

describe('removePendingProposal', () => {
  it('removes a directory-shaped proposal', () => {
    const file = dirProposal()
    removePendingProposal(home, file)
    expect(listProposals(home)).toHaveLength(0)
    expect(fs.existsSync(path.join(proposalsDir(home), file))).toBe(false)
  })
})

// The `editedFiles` content-bearing scenarios — edited/<relPath> written beside the untouched
// original, `edited_files:` frontmatter sorted, and a `..`-bearing key rejected — can only be
// driven by passing editedFiles into `archive`, and nothing does yet: `acceptProposal`'s opts
// has no `editedFiles` field, and `rejectProposal` has no way to carry edits at all. Task 7
// adds that passthrough. `archive` is module-private on purpose, so those three cases are
// deferred to whichever test lands alongside Task 7's wiring rather than exported here just to
// reach them. This covers what IS reachable today through the public API.
describe('archive: editedFiles (no caller passes it yet)', () => {
  it('writes no edited/ directory and no edited_files: line when nothing is edited', () => {
    const file = dirProposal()
    rejectProposal(home, file, { tag: 'wrong' })
    const archived = path.join(proposalsArchiveDir(home), file)
    expect(fs.existsSync(path.join(archived, 'edited'))).toBe(false)
    expect(fs.readFileSync(path.join(archived, 'SKILL.md'), 'utf8')).not.toContain('edited_files:')
  })
})
