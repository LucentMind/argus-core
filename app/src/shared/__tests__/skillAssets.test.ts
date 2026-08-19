import { describe, expect, it } from 'vitest'
import {
  assetPathError,
  assetSetError,
  isExecutableAsset,
  MAX_ASSET_FILES,
  MAX_ASSET_FILE_BYTES
} from '../skillAssets'

describe('assetPathError', () => {
  it.each(['scripts/collect.sh', 'templates/report.md', 'data/fixtures/one.json', 'notes.txt'])(
    'accepts %s',
    (p) => {
      expect(assetPathError(p)).toBeNull()
    }
  )

  it.each([
    ['', 'empty'],
    ['/etc/passwd', 'absolute'],
    ['C:/Windows/system32/x.dll', 'drive letter'],
    ['c:x.txt', 'drive letter'],
    ['..', 'traversal'],
    ['../outside.sh', 'traversal'],
    ['scripts/../../outside.sh', 'traversal'],
    ['scripts/./x.sh', 'dot segment'],
    ['scripts\\collect.sh', 'backslash'],
    ['scripts//collect.sh', 'empty segment'],
    ['SKILL.md', 'SKILL.md is the body'],
    ['skill.md', 'SKILL.md is the body, case-insensitively'],
    ['a/b/c/d.txt', 'too deep'],
    ['NUL', 'windows reserved'],
    ['scripts/nul.sh', 'windows reserved'],
    ['scripts/COM1.txt', 'windows reserved'],
    ['scripts/x .sh', 'illegal character'],
    ['scripts/x.sh.', 'trailing dot']
  ])('rejects %s (%s)', (p) => {
    expect(assetPathError(p)).not.toBeNull()
  })
})

describe('assetSetError', () => {
  it('accepts a small legal set', () => {
    expect(assetSetError([{ path: 'scripts/a.sh', content: 'x' }])).toBeNull()
  })

  it('rejects a duplicate path', () => {
    const files = [
      { path: 'scripts/a.sh', content: 'x' },
      { path: 'scripts/a.sh', content: 'y' }
    ]
    expect(assetSetError(files)).toMatch(/duplicate/i)
  })

  it('rejects more than MAX_ASSET_FILES files', () => {
    const files = Array.from({ length: MAX_ASSET_FILES + 1 }, (_, i) => ({
      path: `f${i}.txt`,
      content: 'x'
    }))
    expect(assetSetError(files)).toMatch(/at most 32/i)
  })

  it('rejects one oversized file, naming the path', () => {
    const files = [{ path: 'big.txt', content: 'x'.repeat(MAX_ASSET_FILE_BYTES + 1) }]
    expect(assetSetError(files)).toContain('big.txt')
  })

  it('rejects a set over the total cap even when each file is legal', () => {
    const files = Array.from({ length: 8 }, (_, i) => ({
      path: `f${i}.txt`,
      content: 'x'.repeat(40 * 1024)
    }))
    expect(assetSetError(files)).toMatch(/256 KB|total/i)
  })

  it('reports the offending path for an illegal member', () => {
    const files = [{ path: '../evil.sh', content: 'x' }]
    expect(assetSetError(files)).toContain('../evil.sh')
  })
})

describe('isExecutableAsset', () => {
  it.each(['scripts/a.sh', 'a.ps1', 'a.py', 'a.bat', 'a.cmd', 'a.mjs'])(
    'treats %s as executable by extension',
    (p) => {
      expect(isExecutableAsset(p, 'echo hi')).toBe(true)
    }
  )

  it('treats a shebang file as executable whatever the extension', () => {
    expect(isExecutableAsset('bin/run', '#!/usr/bin/env bash\necho hi')).toBe(true)
  })

  it('does not treat prose or data as executable', () => {
    expect(isExecutableAsset('templates/report.md', '# Report')).toBe(false)
    expect(isExecutableAsset('data/x.json', '{}')).toBe(false)
  })
})
