import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listReferenceFiles } from '../refSync/referenceFiles'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-nested-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('listReferenceFiles hardening', () => {
  it('excludes a nested INDEX.md, not just the top-level one', () => {
    // A pack shipping its own sub-router is still shipping a generated file, and
    // shared/assetEditable.ts only recognizes the top-level name — so a relPath compare here
    // would list it as an ordinary, editable reference.
    fs.mkdirSync(path.join(dir, 'protocols'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'INDEX.md'), 'top router')
    fs.writeFileSync(path.join(dir, 'protocols', 'INDEX.md'), 'sub router')
    fs.writeFileSync(path.join(dir, 'protocols', 'real.md'), 'body')
    expect(listReferenceFiles(dir)).toEqual(['protocols/real.md'])
  })

  it('returns empty when the path is a file rather than a directory', () => {
    // existsSync passes for a plain file; the scandir then fails ENOTDIR. This walk runs on the
    // CaseSession constructor path, so it must degrade rather than throw.
    const notADir = path.join(dir, 'plain.txt')
    fs.writeFileSync(notADir, 'x')
    expect(listReferenceFiles(notADir)).toEqual([])
  })

  it('skips an unreadable subdirectory but still returns its readable siblings', () => {
    fs.writeFileSync(path.join(dir, 'top.md'), 'a')
    // A FILE where the walk expects to recurse: readdirSync on it throws ENOTDIR from inside
    // the recursion, which must not lose `top.md`.
    fs.mkdirSync(path.join(dir, 'good'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'good', 'inner.md'), 'b')
    expect(listReferenceFiles(dir)).toEqual(['good/inner.md', 'top.md'])
  })
})
