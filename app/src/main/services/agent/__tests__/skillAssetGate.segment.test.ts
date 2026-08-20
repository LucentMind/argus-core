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

const isWin = process.platform === 'win32'

/** `C:\Users\x\y.sh` -> `/c/Users/x/y.sh`, the absolute-path spelling git-bash uses. */
function msys(win: string): string {
  return `/${win[0].toLowerCase()}${win.slice(2).replace(/\\/g, '/')}`
}

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

  // The grant key `risk.ts` builds is `hash + segmentKey`, so the segment digest is what stops
  // an approval of `sh collect.sh` from also covering `sh collect.sh --purge /`.
  describe('segmentKey', () => {
    it('is a sha256 digest of the segment', () => {
      const abs = seed('scripts/collect.sh', SCRIPT)
      expect(ctxFor(`bash ${abs}`)!.segmentKey).toMatch(/^[0-9a-f]{64}$/)
    })

    it('is stable across incidental whitespace', () => {
      const abs = seed('scripts/collect.sh', SCRIPT)
      expect(ctxFor(`  bash   ${abs}  `)!.segmentKey).toBe(ctxFor(`bash ${abs}`)!.segmentKey)
    })

    it('differs when the arguments or redirections differ', () => {
      const abs = seed('scripts/collect.sh', SCRIPT)
      const plain = ctxFor(`bash ${abs}`)!.segmentKey
      expect(ctxFor(`bash ${abs} --purge /`)!.segmentKey).not.toBe(plain)
      expect(ctxFor(`bash ${abs} > ${path.join(cwd, 'out.txt')}`)!.segmentKey).not.toBe(plain)
    })

    it('does not vary with the script bytes — that is what `hash` is for', () => {
      const abs = seed('scripts/collect.sh', SCRIPT)
      const before = ctxFor(`bash ${abs}`)!.segmentKey
      fs.writeFileSync(abs, `${SCRIPT}# one more line\n`)
      expect(ctxFor(`bash ${abs}`)!.segmentKey).toBe(before)
    })
  })

  // Fix 5: classification must stay total. A broken/closed review table used to throw straight
  // out of `classifyToolCall` into `handleToolRequest`.
  it('falls back to unreviewed when the review lookup throws', () => {
    const abs = seed('scripts/collect.sh', SCRIPT)
    recordAssetReviews(db, 'collect-logs', [{ relPath: 'scripts/collect.sh', content: SCRIPT }], {
      origin: 'proposal',
      reviewedBy: null
    })
    expect(ctxFor(`bash ${abs}`)).toMatchObject({ reviewState: 'reviewed' })
    db.exec('DROP TABLE skill_asset_reviews')
    expect(ctxFor(`bash ${abs}`)).toMatchObject({ reviewState: 'unreviewed' })
  })

  // The live-run defect: on Windows the agent's shell is git-bash, and the model wrote
  // `sh "/c/Users/…/scripts/probe.sh"`. `path.resolve` turned that into `C:\c\Users\…`, which
  // does not exist, so the gate found no asset and an unreviewed script ran with no card at all.
  describe.skipIf(!isWin)('MSYS (git-bash) path spellings', () => {
    it('gates a script named with an MSYS absolute path', () => {
      const abs = seed('scripts/collect.sh', SCRIPT)
      const win = ctxFor(`sh ${abs}`)
      const c = ctxFor(`sh ${msys(abs)}`)
      expect(c).toMatchObject({
        skill: 'collect-logs',
        tier: 'user',
        relPath: 'scripts/collect.sh',
        reviewState: 'unreviewed'
      })
      expect(c?.hash).toBe(win?.hash)
      expect(c?.body).toBe(SCRIPT)
    })

    it('gates it when quoted — the exact shape the live run used', () => {
      const abs = seed('scripts/probe.sh', SCRIPT)
      expect(ctxFor(`sh "${msys(abs)}"`)).toMatchObject({ relPath: 'scripts/probe.sh' })
    })

    it('leaves a multi-letter leading segment alone', () => {
      const abs = seed('scripts/collect.sh', SCRIPT)
      expect(ctxFor(`sh /usr${abs.slice(2).replace(/\\/g, '/')}`)).toBeNull()
      expect(ctxFor('/usr/bin/env sh /config/x.sh')).toBeNull()
    })
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
