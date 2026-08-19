import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createDetection } from '../../packs/detection'
import { argusToolHandlers, NATIVE_TOOL_SPECS } from '../nativeTools'
import { listProposals } from '../../proposals'
import { proposalsDir } from '../../paths'

let tmp: string
let home: string
let db: DatabaseSync
let h: ReturnType<typeof argusToolHandlers>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-nt-wp-files-'))
  home = path.join(tmp, 'home')
  db = openDb(path.join(home, 'argus.db'))
  const rec = createCase(db, home, { slug: 'NAV-1', title: 't' })
  h = argusToolHandlers({
    db,
    argusHome: home,
    detection: createDetection(),
    caseId: rec.id,
    caseSlug: 'NAV-1',
    sessionId: 1,
    emitFinding: vi.fn(),
    githubWatermark: () => ({ enabled: false, text: '' })
  })
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('write_proposal files', () => {
  it('declares files in its schema', () => {
    const spec = NATIVE_TOOL_SPECS.find((s) => s.name === 'write_proposal')!
    expect(Object.keys(spec.schema)).toContain('files')
  })

  it('creates a directory-shaped proposal carrying the sibling', async () => {
    await h.write_proposal({
      type: 'skill-new',
      target: 'collect-logs',
      title: 'Collect logs',
      content: '---\ndescription: collect logs\n---\n# Collect logs\n',
      files: [{ path: 'scripts/collect.sh', content: '#!/bin/sh\necho hi\n' }]
    })
    const rec = listProposals(home)[0]
    expect(rec.files?.map((f) => f.path)).toEqual(['scripts/collect.sh'])
    expect(
      fs.readFileSync(path.join(proposalsDir(home), rec.file, 'scripts', 'collect.sh'), 'utf8')
    ).toContain('echo hi')
  })

  it('surfaces the offending path when a file path is illegal', async () => {
    await expect(
      h.write_proposal({
        type: 'skill-new',
        target: 'collect-logs',
        title: 'T',
        content: 'body',
        files: [{ path: '../evil.sh', content: 'x' }]
      })
    ).rejects.toThrow(/evil\.sh/)
  })

  it('ignores a non-array files argument instead of throwing a type error', async () => {
    await h.write_proposal({
      type: 'skill-new',
      target: 'collect-logs',
      title: 'T',
      content: '---\ndescription: d\n---\nbody\n',
      files: 'not-an-array'
    })
    expect(listProposals(home)[0].files).toBeUndefined()
  })
})
