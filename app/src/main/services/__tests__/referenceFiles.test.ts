import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  listReferenceFiles,
  referenceSummary,
  resolveReferencePath
} from '../refSync/referenceFiles'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('listReferenceFiles', () => {
  it('walks nested directories and returns forward-slashed relPaths', () => {
    fs.mkdirSync(path.join(dir, 'protocols'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'top.md'), 'a')
    fs.writeFileSync(path.join(dir, 'protocols', 'nested.md'), 'b')
    expect(listReferenceFiles(dir)).toEqual(['protocols/nested.md', 'top.md'])
  })

  it('excludes the generated INDEX.md router and non-markdown files', () => {
    fs.writeFileSync(path.join(dir, 'INDEX.md'), 'router')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
    fs.writeFileSync(path.join(dir, 'real.md'), 'y')
    expect(listReferenceFiles(dir)).toEqual(['real.md'])
  })

  it('returns empty for a missing directory rather than throwing', () => {
    expect(listReferenceFiles(path.join(dir, 'nope'))).toEqual([])
  })
})

describe('referenceSummary', () => {
  it('takes the first non-heading body line, ignoring frontmatter', () => {
    const raw = '---\ntitle: t\n---\n# Heading\n\nThe summary line.\nMore.\n'
    expect(referenceSummary(raw)).toBe('The summary line.')
  })

  it('is empty when the body is only headings', () => {
    expect(referenceSummary('# Only\n## Headings\n')).toBe('')
  })
})

describe('resolveReferencePath', () => {
  it('resolves a nested relPath inside the root', () => {
    expect(resolveReferencePath(dir, 'protocols/nested.md')).toBe(
      path.join(dir, 'protocols', 'nested.md')
    )
  })

  it('refuses traversal and absolute escapes', () => {
    expect(() => resolveReferencePath(dir, '../evil.md')).toThrow(/invalid reference name/)
    expect(() => resolveReferencePath(dir, path.join(os.tmpdir(), 'evil.md'))).toThrow(
      /invalid reference name/
    )
  })

  it('refuses the root itself', () => {
    expect(() => resolveReferencePath(dir, '.')).toThrow(/invalid reference name/)
  })
})
