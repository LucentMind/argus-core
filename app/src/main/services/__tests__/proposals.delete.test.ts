import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  writeProposal,
  rejectProposal,
  deleteProposal,
  listProposals,
  listArchivedProposals,
  setProposalsChangedNotifier
} from '../proposals'
import { proposalsDir, proposalsArchiveDir } from '../paths'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prop-delete-'))
})
afterEach(() => {
  setProposalsChangedNotifier(() => {})
  fs.rmSync(home, { recursive: true, force: true })
})

function flatProposal(target = 'dlt-cmds'): string {
  return writeProposal(home, 'case-a', {
    type: 'reference-edit',
    target,
    title: `Edit ${target}`,
    content: '# body\n'
  })
}

function dirProposal(): string {
  return writeProposal(home, 'case-a', {
    type: 'skill-new',
    target: 'collect-logs',
    title: 'Collect logs',
    content: '---\ndescription: collect logs\n---\n# Collect logs\n',
    files: [{ path: 'scripts/collect.sh', content: '#!/bin/sh\necho hi\n' }]
  })
}

describe('deleteProposal', () => {
  it('removes a flat pending proposal and writes NO archive row', () => {
    const f = flatProposal()
    deleteProposal(home, f)
    expect(fs.existsSync(path.join(proposalsDir(home), f))).toBe(false)
    expect(listProposals(home)).toHaveLength(0)
    // The whole point: nothing under archive/ — no accepted, no rejected, no third status.
    expect(listArchivedProposals(home)).toHaveLength(0)
    expect(fs.existsSync(path.join(proposalsArchiveDir(home), f))).toBe(false)
  })

  it('removes a directory-shaped pending proposal, siblings included', () => {
    const f = dirProposal()
    deleteProposal(home, f)
    expect(fs.existsSync(path.join(proposalsDir(home), f))).toBe(false)
    expect(listProposals(home)).toHaveLength(0)
    expect(listArchivedProposals(home)).toHaveLength(0)
  })

  it('leaves other pending proposals alone', () => {
    const keep = flatProposal('keep-me')
    const gone = flatProposal('drop-me')
    deleteProposal(home, gone)
    expect(listProposals(home).map((p) => p.file)).toEqual([keep])
  })

  it('fires the changed notifier exactly once', () => {
    const f = flatProposal()
    const cb = vi.fn()
    setProposalsChangedNotifier(cb)
    deleteProposal(home, f)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('throws Unknown proposal for a file that is not pending, and touches nothing', () => {
    expect(() => deleteProposal(home, 'nope.md')).toThrow(/Unknown proposal/)
  })

  it('refuses an already-archived file name (reject first, then try to delete it)', () => {
    const f = flatProposal()
    rejectProposal(home, f, { tag: 'wrong' })
    const archived = path.join(proposalsArchiveDir(home), f)
    expect(fs.existsSync(archived)).toBe(true)
    expect(() => deleteProposal(home, f)).toThrow(/Unknown proposal/)
    // The rejection record survives: delete is pending-only by spec.
    expect(fs.existsSync(archived)).toBe(true)
    expect(listArchivedProposals(home)).toHaveLength(1)
  })

  it('blocks path traversal to files outside proposals/', () => {
    const decoy = path.join(home, 'decoy.md')
    fs.writeFileSync(decoy, '---\ntype: reference-edit\nstatus: pending\n---\nx\n')
    expect(() => deleteProposal(home, '../decoy.md')).toThrow(/Unknown proposal/)
    expect(fs.existsSync(decoy)).toBe(true)
  })

  it('refuses a bare basename that matches a pending file only when joined from elsewhere', () => {
    // removePendingProposal joins path.basename(file) — so `../<pending>` would resolve to the
    // real pending file if the lookup were skipped. The listProposals lookup must run first.
    const f = flatProposal()
    expect(() => deleteProposal(home, `../${f}`)).toThrow(/Unknown proposal/)
    expect(fs.existsSync(path.join(proposalsDir(home), f))).toBe(true)
  })
})
