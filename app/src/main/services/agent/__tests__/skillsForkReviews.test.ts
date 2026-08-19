import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../db'
import { forkSkill, deleteUserSkill } from '../skillsResolver'
import { recordAssetReviews, assetReviewState } from '../../skillAssetReviews'
import { userSkillsDir, hivemindSkillsDir } from '../../paths'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-fork-reviews-'))
  db = openDb(path.join(home, 'argus.db'))
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

const SCRIPT = '#!/bin/sh\necho hi\n'

function installUserSkill(name: string): void {
  const dir = path.join(userSkillsDir(home), name)
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n# ${name}\n`)
  fs.writeFileSync(path.join(dir, 'scripts', 'collect.sh'), SCRIPT)
  recordAssetReviews(db, name, [{ relPath: 'scripts/collect.sh', content: SCRIPT }], {
    origin: 'proposal',
    reviewedBy: null
  })
}

// forkSkill refuses a source that is already user tier ("is already yours" —
// skillsResolver.ts's forkSkill guard; ForkSkillDialog's own docstring confirms every real
// caller only ever forks a hivemind-tier skill). So the fork case installs the reviewed asset
// at hivemind tier, not user tier, unlike installUserSkill above.
function installHivemindSkill(name: string): void {
  const dir = path.join(hivemindSkillsDir(home), name)
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n# ${name}\n`)
  fs.writeFileSync(path.join(dir, 'scripts', 'collect.sh'), SCRIPT)
  recordAssetReviews(db, name, [{ relPath: 'scripts/collect.sh', content: SCRIPT }], {
    origin: 'proposal',
    reviewedBy: null
  })
}

describe('review rows follow the skill', () => {
  it('fork under a new name carries the reviewed state', () => {
    installHivemindSkill('collect-logs')
    forkSkill(home, 'collect-logs', 'collect-logs-mine', null, { db })
    expect(assetReviewState(db, 'collect-logs-mine', 'scripts/collect.sh', SCRIPT)).toBe('reviewed')
  })

  it('deleting the user copy drops its rows', () => {
    installUserSkill('collect-logs')
    deleteUserSkill(home, 'collect-logs', { db })
    expect(assetReviewState(db, 'collect-logs', 'scripts/collect.sh', SCRIPT)).toBe('unreviewed')
  })

  it('works with no db (rows are simply not touched)', () => {
    installUserSkill('collect-logs')
    expect(() => deleteUserSkill(home, 'collect-logs')).not.toThrow()
  })
})
