import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { scaffoldCaseLinks, SLUG_RE } from '../caseService'
import { sha256File } from '../ingest'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-scaffold-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

describe('scaffoldCaseLinks', () => {
  it('creates .claude junctions for existing targets and is idempotent', () => {
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true })
    const dir = path.join(home, 'cases', 'X-1')
    fs.mkdirSync(dir, { recursive: true })
    scaffoldCaseLinks(home, dir)
    scaffoldCaseLinks(home, dir) // second run must not throw
    expect(fs.lstatSync(path.join(dir, '.claude', 'skills')).isSymbolicLink()).toBe(true)
    // references target missing -> link skipped, no throw
    expect(fs.existsSync(path.join(dir, '.claude', 'references'))).toBe(false)
  })
})

describe('exported seams', () => {
  it('SLUG_RE matches the createCase contract', () => {
    expect(SLUG_RE.test('NAV-100')).toBe(true)
    expect(SLUG_RE.test('-bad')).toBe(false)
  })
  it('sha256File hashes file content', () => {
    const f = path.join(home, 'x.txt')
    fs.writeFileSync(f, 'hello')
    expect(sha256File(f)).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })
})
