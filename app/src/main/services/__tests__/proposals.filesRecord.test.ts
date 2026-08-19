import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../db'
import { writeProposal, acceptProposal, listProposals } from '../proposals'
import { proposalsDir } from '../paths'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prop-files-record-'))
  db = openDb(path.join(home, 'argus.db'))
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

const BODY = '---\ndescription: collect logs\n---\n# Collect logs\n'

describe('ProposalRecord.files', () => {
  it('is absent for a flat proposal', () => {
    writeProposal(home, 'acme-1', {
      type: 'skill-new',
      target: 'plain-skill',
      title: 'Plain',
      content: BODY
    })
    expect(listProposals(home)[0].files).toBeUndefined()
  })

  it('lists each sibling with its exec flag and a null current for a new skill', () => {
    writeProposal(home, 'acme-1', {
      type: 'skill-new',
      target: 'collect-logs',
      title: 'Collect logs',
      content: BODY,
      files: [
        { path: 'scripts/collect.sh', content: '#!/bin/sh\necho hi\n' },
        { path: 'templates/report.md', content: '# Report\n' }
      ]
    })
    const files = listProposals(home)[0].files
    expect(files).toEqual([
      {
        path: 'scripts/collect.sh',
        content: '#!/bin/sh\necho hi\n',
        current: null,
        exec: true
      },
      { path: 'templates/report.md', content: '# Report\n', current: null, exec: false }
    ])
  })

  it('fills current from the installed skill on a skill-edit', () => {
    const first = writeProposal(home, 'acme-1', {
      type: 'skill-new',
      target: 'collect-logs',
      title: 'Collect logs',
      content: BODY,
      files: [{ path: 'scripts/collect.sh', content: '#!/bin/sh\necho v1\n' }]
    })
    acceptProposal(home, first, { db, identity: null })
    writeProposal(home, 'acme-2', {
      type: 'skill-edit',
      target: 'collect-logs',
      title: 'v2',
      content: BODY,
      files: [{ path: 'scripts/collect.sh', content: '#!/bin/sh\necho v2\n' }]
    })
    const rec = listProposals(home).find((p) => p.type === 'skill-edit')!
    expect(rec.files?.[0]).toEqual({
      path: 'scripts/collect.sh',
      content: '#!/bin/sh\necho v2\n',
      current: '#!/bin/sh\necho v1\n',
      exec: true
    })
  })

  it('surfaces an unreadable sibling file instead of dropping it', () => {
    const file = writeProposal(home, 'acme-1', {
      type: 'skill-new',
      target: 'collect-logs',
      title: 'Collect logs',
      content: BODY,
      files: [{ path: 'scripts/collect.sh', content: '#!/bin/sh\necho hi\n' }]
    })
    // Target only the proposal's own sibling copy — the SKILL.md frontmatter read that
    // listProposals also does, and any other file in this suite, must go through untouched.
    const badPath = path.join(proposalsDir(home), file, 'scripts', 'collect.sh')
    const real = fs.readFileSync
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      if (args[0] === badPath) throw new Error('EACCES: permission denied')
      return real(...args)
    }) as typeof fs.readFileSync)
    try {
      const files = listProposals(home)[0].files
      expect(files).toEqual([
        {
          path: 'scripts/collect.sh',
          content: '',
          current: null,
          exec: true,
          unreadable: true
        }
      ])
    } finally {
      spy.mockRestore()
    }
  })
})
