import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deleteSkillFileReviewed, renameSkillFileReviewed, saveSkillFile } from '../skillFiles'
import { openDb } from '../db'
import { assetReviewState } from '../skillAssetReviews'
import { hivemindSkillsDir, userSkillsDir } from '../paths'

let home: string
let db: DatabaseSync

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-skill-save-'))
  db = openDb(path.join(home, 'argus.db'))
  const dir = path.join(userSkillsDir(home), 'collect-logs')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: collect-logs\n---\nbody\n')
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('saveSkillFile', () => {
  it('records a review row for an executable sibling — authoring is reviewing', () => {
    const body = '#!/bin/sh\necho hi\n'
    saveSkillFile(
      { argusHome: home, db, reviewedBy: 'Jiawei Han' },
      'collect-logs',
      'scripts/collect.sh',
      body,
      null
    )
    expect(assetReviewState(db, 'collect-logs', 'scripts/collect.sh', body)).toBe('reviewed')
  })

  it('records no row for a non-executable sibling', () => {
    saveSkillFile(
      { argusHome: home, db, reviewedBy: null },
      'collect-logs',
      'templates/report.md',
      '# Report\n',
      null
    )
    expect(assetReviewState(db, 'collect-logs', 'templates/report.md', '# Report\n')).toBe(
      'unreviewed'
    )
  })

  // The row means "a human here approved THESE bytes". Saving again must move it, or the run
  // gate would report `changed` for the very bytes the author just wrote.
  it('moves the row when the same file is saved again', () => {
    const first = '#!/bin/sh\necho hi\n'
    const r = saveSkillFile(
      { argusHome: home, db, reviewedBy: null },
      'collect-logs',
      'scripts/collect.sh',
      first,
      null
    )
    const second = '#!/bin/sh\necho bye\n'
    saveSkillFile(
      { argusHome: home, db, reviewedBy: null },
      'collect-logs',
      'scripts/collect.sh',
      second,
      r.hash
    )
    expect(assetReviewState(db, 'collect-logs', 'scripts/collect.sh', second)).toBe('reviewed')
    expect(assetReviewState(db, 'collect-logs', 'scripts/collect.sh', first)).toBe('changed')
  })

  it('writes no row when the write itself is refused', () => {
    expect(() =>
      saveSkillFile(
        { argusHome: home, db, reviewedBy: null },
        'collect-logs',
        '../escape.sh',
        'x\n',
        null
      )
    ).toThrow()
    expect(assetReviewState(db, 'collect-logs', '../escape.sh', 'x\n')).toBe('unreviewed')
  })
})

// triage 3: deleting or renaming a sibling must not leave its review row stranded.
describe('deleteSkillFileReviewed', () => {
  it('deletes the file and drops its review row', () => {
    const body = '#!/bin/sh\necho hi\n'
    saveSkillFile(
      { argusHome: home, db, reviewedBy: 'Jiawei Han' },
      'collect-logs',
      'scripts/collect.sh',
      body,
      null
    )
    expect(assetReviewState(db, 'collect-logs', 'scripts/collect.sh', body)).toBe('reviewed')

    deleteSkillFileReviewed({ argusHome: home, db }, 'collect-logs', 'scripts/collect.sh')

    expect(
      fs.existsSync(path.join(userSkillsDir(home), 'collect-logs/scripts/collect.sh'))
    ).toBe(false)
    expect(assetReviewState(db, 'collect-logs', 'scripts/collect.sh', body)).toBe('unreviewed')
  })

  it('leaves a still-refused delete with the review row intact', () => {
    // A read-only (hivemind-tier) skill: `mutable()` throws before any filesystem or db work.
    const dir = path.join(hivemindSkillsDir(home), 'theirs')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: theirs\n---\nbody\n')
    expect(() =>
      deleteSkillFileReviewed({ argusHome: home, db }, 'theirs', 'run.sh')
    ).toThrow(/read-only/i)
  })
})

describe('renameSkillFileReviewed', () => {
  it('renames the file and carries its review row to the new path', () => {
    const body = '#!/bin/sh\necho hi\n'
    saveSkillFile(
      { argusHome: home, db, reviewedBy: 'Jiawei Han' },
      'collect-logs',
      'scripts/old.sh',
      body,
      null
    )

    renameSkillFileReviewed({ argusHome: home, db }, 'collect-logs', 'scripts/old.sh', 'scripts/new.sh')

    expect(
      fs.existsSync(path.join(userSkillsDir(home), 'collect-logs/scripts/old.sh'))
    ).toBe(false)
    expect(assetReviewState(db, 'collect-logs', 'scripts/new.sh', body)).toBe('reviewed')
    expect(assetReviewState(db, 'collect-logs', 'scripts/old.sh', body)).toBe('unreviewed')
  })
})
