import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../db'
import { writeProposal, acceptProposal } from '../proposals'
import { assetReviewState } from '../skillAssetReviews'
import { userSkillsDir, proposalsArchiveDir } from '../paths'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prop-accept-files-'))
  db = openDb(path.join(home, 'argus.db'))
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

const SCRIPT = '#!/bin/sh\necho hi\n'
const BODY = '---\ndescription: collect logs\n---\n# Collect logs\n'

function propose(files = [{ path: 'scripts/collect.sh', content: SCRIPT }]): string {
  return writeProposal(home, 'acme-1', {
    type: 'skill-new',
    target: 'collect-logs',
    title: 'Collect logs',
    content: BODY,
    files
  })
}

describe('accepting a directory-shaped proposal', () => {
  it('writes SKILL.md and every sibling into skills-user', () => {
    const accepted = acceptProposal(home, propose(), { db, identity: null })
    expect(accepted).toEqual({ kind: 'skill', name: 'collect-logs' })
    const dest = path.join(userSkillsDir(home), 'collect-logs')
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toContain('# Collect logs')
    expect(fs.readFileSync(path.join(dest, 'scripts', 'collect.sh'), 'utf8')).toBe(SCRIPT)
  })

  it('leaves no staging or trash directory behind', () => {
    acceptProposal(home, propose(), { db, identity: null })
    const left = fs.readdirSync(userSkillsDir(home)).filter((n) => n.startsWith('.'))
    expect(left).toEqual([])
  })

  it('records a review row for the executable only', () => {
    acceptProposal(
      home,
      propose([
        { path: 'scripts/collect.sh', content: SCRIPT },
        { path: 'templates/report.md', content: '# Report\n' }
      ]),
      { db, identity: null }
    )
    expect(assetReviewState(db, 'collect-logs', 'scripts/collect.sh', SCRIPT)).toBe('reviewed')
    expect(assetReviewState(db, 'collect-logs', 'templates/report.md', '# Report\n')).toBe(
      'unreviewed'
    )
  })

  it('applies a per-file edit and reviews the EDITED bytes', () => {
    const edited = '#!/bin/sh\necho edited\n'
    acceptProposal(home, propose(), {
      db,
      identity: null,
      editedFiles: { 'scripts/collect.sh': edited }
    })
    const dest = path.join(userSkillsDir(home), 'collect-logs')
    expect(fs.readFileSync(path.join(dest, 'scripts', 'collect.sh'), 'utf8')).toBe(edited)
    expect(assetReviewState(db, 'collect-logs', 'scripts/collect.sh', edited)).toBe('reviewed')
    expect(assetReviewState(db, 'collect-logs', 'scripts/collect.sh', SCRIPT)).toBe('changed')
  })

  it('rejects an edit whose path was not in the proposal', () => {
    expect(() =>
      acceptProposal(home, propose(), {
        db,
        identity: null,
        editedFiles: { 'scripts/other.sh': 'x' }
      })
    ).toThrow(/scripts\/other\.sh/)
  })

  it('rejects a traversal path in editedFiles and writes nothing', () => {
    const file = propose()
    expect(() =>
      acceptProposal(home, file, { db, identity: null, editedFiles: { '../evil.sh': 'x' } })
    ).toThrow(/edited file not in the proposal|\.\. are not allowed/)
    // The paths a real escape would actually reach: staging lives UNDER skills-user, so `..`
    // from a staged file lands there, and `archive` joins `edited/<rel>` under `<archive>/<file>`,
    // so `..` lands beside it. Asserting `<home>/evil.sh` instead would pin a path no bug could
    // write. The archive half is belt-and-braces only — `acceptProposal`'s unknown-key check
    // throws before `archive` runs, so `archive`'s own `assetPathError` guard is not exercised
    // here; it would only start mattering if that ordering ever changed.
    expect(fs.existsSync(path.join(userSkillsDir(home), 'evil.sh'))).toBe(false)
    expect(fs.existsSync(path.join(proposalsArchiveDir(home), file, 'evil.sh'))).toBe(false)
  })

  // Task 4 built `archive`'s editedFiles handling but could not test it: nothing threaded edits
  // into `archive` until this task. These three cases are that coverage, and they are the
  // reason the (draft, edited) pair survives into the archive at all — accept-time human edits
  // are the highest-signal training data the system produces.
  it('archives the ORIGINAL sibling verbatim and the edit beside it', () => {
    const edited = '#!/bin/sh\necho edited\n'
    const file = propose()
    acceptProposal(home, file, {
      db,
      identity: null,
      editedFiles: { 'scripts/collect.sh': edited }
    })
    const archived = path.join(proposalsArchiveDir(home), file)
    expect(fs.readFileSync(path.join(archived, 'scripts', 'collect.sh'), 'utf8')).toBe(SCRIPT)
    expect(fs.readFileSync(path.join(archived, 'edited', 'scripts', 'collect.sh'), 'utf8')).toBe(
      edited
    )
  })

  it('stamps edited_files as a SORTED comma-joined list', () => {
    const file = propose([
      { path: 'scripts/collect.sh', content: SCRIPT },
      { path: 'aaa.txt', content: 'a\n' }
    ])
    // deliberately passed out of sort order — the assertion pins the sort, not the input order
    acceptProposal(home, file, {
      db,
      identity: null,
      editedFiles: { 'scripts/collect.sh': '#!/bin/sh\necho x\n', 'aaa.txt': 'b\n' }
    })
    const fm = fs.readFileSync(path.join(proposalsArchiveDir(home), file, 'SKILL.md'), 'utf8')
    expect(fm).toContain('edited_files: aaa.txt,scripts/collect.sh')
  })

  it('writes no edited/ subtree and no edited_files line when nothing was edited', () => {
    const file = propose()
    acceptProposal(home, file, { db, identity: null })
    const archived = path.join(proposalsArchiveDir(home), file)
    expect(fs.existsSync(path.join(archived, 'edited'))).toBe(false)
    expect(fs.readFileSync(path.join(archived, 'SKILL.md'), 'utf8')).not.toContain('edited_files:')
  })

  // The carry-forward is NOT gated on the proposal type. Accept already permits a skill-new onto
  // a skill that exists (it merges that skill's authorship), so gating on `skill-edit` would let
  // a proposal's `type` decide whether the user's existing files survive. Deletion is a human
  // editor action; no proposal type may cause it.
  it('carries forward existing siblings on a skill-NEW aimed at an existing skill', () => {
    acceptProposal(home, propose(), { db, identity: null })
    const again = writeProposal(home, 'acme-2', {
      type: 'skill-new',
      target: 'collect-logs',
      title: 'Collect logs again',
      content: BODY,
      files: [{ path: 'templates/report.md', content: '# Report\n' }]
    })
    acceptProposal(home, again, { db, identity: null })
    const dest = path.join(userSkillsDir(home), 'collect-logs')
    expect(fs.readFileSync(path.join(dest, 'scripts', 'collect.sh'), 'utf8')).toBe(SCRIPT)
    expect(fs.readFileSync(path.join(dest, 'templates', 'report.md'), 'utf8')).toBe('# Report\n')
  })

  // Carry-forward is a byte copy, not a utf8 read/write round trip. Imported skills and HiveMind
  // pulls can carry PNGs, zips and UTF-16 text; a round trip would replace those bytes with
  // U+FFFD and hand the user a corrupt file with no error anywhere.
  it('preserves a NON-UTF8 sibling byte for byte', () => {
    acceptProposal(home, propose(), { db, identity: null })
    const dest = path.join(userSkillsDir(home), 'collect-logs')
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x01])
    fs.writeFileSync(path.join(dest, 'logo.png'), bytes)
    const again = writeProposal(home, 'acme-2', {
      type: 'skill-edit',
      target: 'collect-logs',
      title: 'Collect logs v2',
      content: BODY,
      files: [{ path: 'templates/report.md', content: '# Report\n' }]
    })
    acceptProposal(home, again, { db, identity: null })
    expect(fs.readFileSync(path.join(dest, 'logo.png'))).toEqual(bytes)
  })

  // Gated, not omitted: CI runs a macOS lane on every push, so this really does execute there;
  // Windows has no +x bit to preserve. It is the only claim in the copy-based carry-forward with
  // nothing else behind it — a refactor back to writeFileSync would keep the binary case green
  // (bytes survive a Buffer round trip) while silently dropping the executable bit.
  it.skipIf(process.platform === 'win32')('preserves the +x bit on a carried sibling', () => {
    acceptProposal(home, propose(), { db, identity: null })
    const sib = path.join(userSkillsDir(home), 'collect-logs', 'scripts', 'collect.sh')
    fs.chmodSync(sib, 0o755)
    const again = writeProposal(home, 'acme-2', {
      type: 'skill-edit',
      target: 'collect-logs',
      title: 'Collect logs v2',
      content: BODY,
      files: [{ path: 'templates/report.md', content: '# Report\n' }]
    })
    acceptProposal(home, again, { db, identity: null })
    expect(fs.statSync(sib).mode & 0o111).not.toBe(0)
  })

  it('carries forward existing siblings on a skill-edit', () => {
    acceptProposal(home, propose(), { db, identity: null })
    const editFile = writeProposal(home, 'acme-2', {
      type: 'skill-edit',
      target: 'collect-logs',
      title: 'Collect logs v2',
      content: BODY.replace('# Collect logs', '# Collect logs v2'),
      files: [{ path: 'templates/report.md', content: '# Report\n' }]
    })
    acceptProposal(home, editFile, { db, identity: null })
    const dest = path.join(userSkillsDir(home), 'collect-logs')
    expect(fs.readFileSync(path.join(dest, 'scripts', 'collect.sh'), 'utf8')).toBe(SCRIPT)
    expect(fs.readFileSync(path.join(dest, 'templates', 'report.md'), 'utf8')).toBe('# Report\n')
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toContain('# Collect logs v2')
  })

  it('leaves the previous skill intact when the swap fails mid-way', () => {
    acceptProposal(home, propose(), { db, identity: null })
    const dest = path.join(userSkillsDir(home), 'collect-logs')
    const before = fs.readFileSync(path.join(dest, 'scripts', 'collect.sh'), 'utf8')
    const editFile = writeProposal(home, 'acme-2', {
      type: 'skill-edit',
      target: 'collect-logs',
      title: 'v2',
      content: BODY,
      files: [{ path: 'scripts/collect.sh', content: '#!/bin/sh\necho v2\n' }]
    })
    // Fail the SECOND rename — the staged→final step, after the original has been moved aside.
    // The fault must land inside the swap, not before it: a fault that aborts earlier proves
    // nothing about the branch under test.
    const realRename = fs.renameSync
    let calls = 0
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: string, to: string) => {
      calls++
      if (calls === 2) throw new Error('boom')
      return realRename(from, to)
    }) as typeof fs.renameSync)
    expect(() => acceptProposal(home, editFile, { db, identity: null })).toThrow(/boom/)
    spy.mockRestore()
    expect(fs.readFileSync(path.join(dest, 'scripts', 'collect.sh'), 'utf8')).toBe(before)
    expect(fs.readdirSync(userSkillsDir(home)).filter((n) => n.startsWith('.'))).toEqual([])
  })
})

describe('flat proposals are unchanged', () => {
  it('accepts a flat skill proposal exactly as before', () => {
    const file = writeProposal(home, 'acme-1', {
      type: 'skill-new',
      target: 'plain-skill',
      title: 'Plain',
      content: '---\ndescription: plain\n---\n# Plain\n'
    })
    expect(acceptProposal(home, file, { db, identity: null })).toEqual({
      kind: 'skill',
      name: 'plain-skill'
    })
    const dest = path.join(userSkillsDir(home), 'plain-skill')
    expect(fs.readdirSync(dest)).toEqual(['SKILL.md'])
  })
})
