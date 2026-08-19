import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { skillAssetAt } from '../skillAssetGate'
import { hivemindSkillsDir, userSkillsDir } from '../../paths'
import { sharedSkillsDir } from '../../skillsDir'

let home: string
let caseDir: string

/** Write a skill directory in `root` and return the absolute path of one asset inside it. */
function seed(root: string, skill: string, rel: string, body: string): string {
  const abs = path.join(root, skill, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
  return abs
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-asset-gate-'))
  caseDir = path.join(home, 'cases', 'ACME-1')
  fs.mkdirSync(path.join(caseDir, '.claude', 'skills'), { recursive: true })
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('skillAssetAt', () => {
  it('identifies a user-tier asset by its real path', () => {
    const abs = seed(userSkillsDir(home), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    expect(skillAssetAt(home, abs)).toEqual({
      tier: 'user',
      skill: 'collect-logs',
      relPath: 'scripts/collect.sh'
    })
  })

  it('identifies the hivemind and bundled tiers too', () => {
    const hive = seed(hivemindSkillsDir(home), 'team-skill', 'run.sh', 'echo hi\n')
    const bundled = seed(sharedSkillsDir(home), 'packed', 'bin/go', 'echo hi\n')
    expect(skillAssetAt(home, hive)).toMatchObject({ tier: 'hivemind', skill: 'team-skill' })
    expect(skillAssetAt(home, bundled)).toMatchObject({ tier: 'bundled', skill: 'packed' })
  })

  // The one that matters: this is the ONLY path a shell command actually sees, because
  // materializeSessionSkills junctions each enabled skill into the case directory.
  it('resolves through the per-case junction to the real tier', () => {
    seed(userSkillsDir(home), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    fs.symlinkSync(
      path.join(userSkillsDir(home), 'collect-logs'),
      path.join(caseDir, '.claude', 'skills', 'collect-logs'),
      'junction'
    )
    const viaJunction = path.join(
      caseDir,
      '.claude',
      'skills',
      'collect-logs',
      'scripts',
      'collect.sh'
    )
    expect(skillAssetAt(home, viaJunction)).toEqual({
      tier: 'user',
      skill: 'collect-logs',
      relPath: 'scripts/collect.sh'
    })
  })

  it('reports a nested asset with a POSIX relative path on every platform', () => {
    const abs = seed(userSkillsDir(home), 'deep', 'a/b/c.sh', 'echo hi\n')
    expect(skillAssetAt(home, abs)?.relPath).toBe('a/b/c.sh')
  })

  it('returns null for a path outside every skills root', () => {
    const abs = path.join(caseDir, 'evidence', 'notes.sh')
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, 'echo hi\n')
    expect(skillAssetAt(home, abs)).toBeNull()
  })

  it('returns null for a path that does not exist', () => {
    expect(skillAssetAt(home, path.join(userSkillsDir(home), 'ghost', 'x.sh'))).toBeNull()
  })

  // `skills-user-backup` shares a prefix with `skills-user`; a raw startsWith would claim it.
  it('does not claim a sibling directory that merely shares a prefix', () => {
    const abs = path.join(home, 'skills-user-backup', 'collect-logs', 'x.sh')
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, 'echo hi\n')
    expect(skillAssetAt(home, abs)).toBeNull()
  })

  it('returns null for the skill directory itself, which is not an asset', () => {
    seed(userSkillsDir(home), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    expect(skillAssetAt(home, path.join(userSkillsDir(home), 'collect-logs'))).toBeNull()
  })
})
