import { describe, it, expect } from 'vitest'
import {
  classifyCitePath,
  linkifyCitations,
  parseCiteHref,
  splitCitations,
  toRepoNameSet
} from '../citations'

describe('citation grammar', () => {
  it('keeps single-line evidence citations working exactly as before', () => {
    const segs = splitCitations('HI [evidence/app.log:412] bye')
    expect(segs).toEqual([
      { type: 'text', text: 'HI ' },
      { type: 'cite', relPath: 'evidence/app.log', start: 412, end: 412 },
      { type: 'text', text: ' bye' }
    ])
  })

  it('parses evidence ranges', () => {
    const [seg] = splitCitations('[evidence/app.log:10-25]')
    expect(seg).toEqual({ type: 'cite', relPath: 'evidence/app.log', start: 10, end: 25 })
  })

  it('recognizes repo citations only when the repo name is supplied', () => {
    const text = 'see [hivemindtest/src/ui/camera.ts:1547-1552]'
    expect(splitCitations(text)).toEqual([{ type: 'text', text }])
    const segs = splitCitations(text, ['hivemindtest'])
    expect(segs[1]).toEqual({
      type: 'cite',
      relPath: 'hivemindtest/src/ui/camera.ts',
      start: 1547,
      end: 1552
    })
  })

  it('repo names match case-insensitively', () => {
    const segs = splitCitations('[HIVEMINDTEST/src/a.ts:5]', ['hivemindtest'])
    expect(segs[0].type).toBe('cite')
  })

  it('unknown repo names and malformed ranges stay plain text', () => {
    expect(splitCitations('[unknown-repo/a.ts:5]', ['hivemindtest'])).toEqual([
      { type: 'text', text: '[unknown-repo/a.ts:5]' }
    ])
    expect(splitCitations('[evidence/app.log:25-10]')).toEqual([
      { type: 'text', text: '[evidence/app.log:25-10]' }
    ])
  })

  it('linkifies ranges into cite:// with an end param', () => {
    expect(linkifyCitations('x [evidence/app.log:10-25] y')).toBe(
      'x [evidence/app.log:10-25](cite://evidence/app.log?line=10&end=25) y'
    )
    expect(linkifyCitations('x [evidence/app.log:10] y')).toBe(
      'x [evidence/app.log:10](cite://evidence/app.log?line=10) y'
    )
    expect(linkifyCitations('[repo1/a.ts:3]', ['repo1'])).toBe(
      '[repo1/a.ts:3](cite://repo1/a.ts?line=3)'
    )
    expect(linkifyCitations('[repo1/a.ts:3]')).toBe('[repo1/a.ts:3]')
  })

  it('parseCiteHref round-trips start/end and defaults end to start', () => {
    expect(parseCiteHref('cite://evidence/app.log?line=10&end=25')).toEqual({
      relPath: 'evidence/app.log',
      start: 10,
      end: 25
    })
    expect(parseCiteHref('cite://repo1/a.ts?line=3')).toEqual({
      relPath: 'repo1/a.ts',
      start: 3,
      end: 3
    })
    expect(parseCiteHref('https://x')).toBeNull()
  })

  it('classifyCitePath separates the domains', () => {
    const names = toRepoNameSet(['hivemindtest'])
    expect(classifyCitePath('evidence/app.log', names)).toBe('evidence')
    expect(classifyCitePath('findings.md', names)).toBe('evidence')
    expect(classifyCitePath('.rca/report.md', names)).toBe('evidence')
    expect(classifyCitePath('hivemindtest/src/a.ts', names)).toBe('repo')
    expect(classifyCitePath('other/src/a.ts', names)).toBeNull()
    expect(classifyCitePath('noslash', names)).toBeNull()
  })
})
