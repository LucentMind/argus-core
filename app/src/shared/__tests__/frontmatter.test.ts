import { describe, it, expect } from 'vitest'
import { fmBlock, fmField, withFrontmatter, fmList, withFrontmatterList } from '../frontmatter'

describe('frontmatter helpers', () => {
  it('parses CRLF and LF blocks', () => {
    const lf = fmBlock('---\ntrust_tier: hivemind\n---\nbody')
    expect(lf && fmField(lf.fm, 'trust_tier')).toBe('hivemind')
    const crlf = fmBlock('---\r\ntrust_tier: hivemind\r\n---\r\nbody')
    expect(crlf && fmField(crlf.fm, 'trust_tier')).toBe('hivemind')
    expect(crlf?.body).toBe('body')
    expect(fmBlock('no frontmatter')).toBeNull()
  })

  it('withFrontmatter overrides existing keys and creates a block when absent', () => {
    const stamped = withFrontmatter('---\ntrust_tier: confluence\ntitle: X\n---\nbody\n', {
      trust_tier: 'hivemind',
      source_commit: 'abc'
    })
    expect(stamped).toContain('trust_tier: hivemind')
    expect(stamped).not.toContain('trust_tier: confluence')
    expect(stamped).toContain('title: X')
    expect(stamped).toContain('source_commit: abc')
    expect(stamped.endsWith('body\n')).toBe(true)
    const created = withFrontmatter('plain body', { trust_tier: 'team-knowledge' })
    expect(created.startsWith('---\ntrust_tier: team-knowledge\n---\n')).toBe(true)
  })
})

describe('block lists', () => {
  const withSources = [
    '---',
    'title: X',
    'trust_tier: confluence',
    'sources:',
    '  - url: https://example.test/a',
    '    page_id: "12345"',
    '    version: 3',
    '    last_synced: 2026-07-01',
    'last_updated: 2026-07-01',
    '---',
    'body\n'
  ].join('\n')

  it('fmList reads scalar list items and ignores absent keys', () => {
    const fm = 'contributors:\n  - A <a@x.test> 2026-07-30\n  - B <b@x.test> 2026-07-31\n'
    expect(fmList(fm, 'contributors')).toEqual([
      'A <a@x.test> 2026-07-30',
      'B <b@x.test> 2026-07-31'
    ])
    expect(fmList(fm, 'nope')).toEqual([])
    expect(fmList('title: X\n', 'title')).toEqual([])
  })

  it('withFrontmatter preserves a mapping list verbatim while overriding a flat key', () => {
    const out = withFrontmatter(withSources, { trust_tier: 'hivemind' })
    expect(out).toContain('trust_tier: hivemind')
    expect(out).not.toContain('trust_tier: confluence')
    // the whole indented run survives, in order, unmodified
    expect(out).toContain(
      'sources:\n  - url: https://example.test/a\n    page_id: "12345"\n    version: 3\n    last_synced: 2026-07-01'
    )
    expect(out).toContain('last_updated: 2026-07-01')
    expect(out.endsWith('body\n')).toBe(true)
  })

  it('withFrontmatter emits flat keys before list keys regardless of input order', () => {
    const out = withFrontmatter(withSources, { author: 'A <a@x.test>' })
    const fm = out.match(/^---\n([\s\S]*?)\n---/)![1]
    expect(fm.indexOf('author:')).toBeLessThan(fm.indexOf('sources:'))
    expect(fm.indexOf('last_updated:')).toBeLessThan(fm.indexOf('sources:'))
  })

  it('withFrontmatterList replaces, appends, and removes', () => {
    const replaced = withFrontmatterList(
      '---\ntitle: X\ncontributors:\n  - A <a@x.test> 2026-07-30\n---\nbody\n',
      'contributors',
      ['B <b@x.test> 2026-07-31']
    )
    expect(replaced).toContain('contributors:\n  - B <b@x.test> 2026-07-31')
    expect(replaced).not.toContain('a@x.test')

    const appended = withFrontmatterList('---\ntitle: X\n---\nbody\n', 'contributors', [
      'A <a@x.test> 2026-07-30'
    ])
    expect(appended).toContain('title: X')
    expect(appended).toContain('contributors:\n  - A <a@x.test> 2026-07-30')

    const created = withFrontmatterList('plain body', 'contributors', ['A <a@x.test> 2026-07-30'])
    expect(created.startsWith('---\ncontributors:\n  - A <a@x.test> 2026-07-30\n---\n')).toBe(true)

    const removed = withFrontmatterList(replaced, 'contributors', [])
    expect(removed).not.toContain('contributors:')
    expect(removed).toContain('title: X')
  })

  it('a flat override of a key that is currently a list drops the list', () => {
    const out = withFrontmatter('---\nroles:\n  - review\n  - triage\n---\nbody\n', {
      roles: 'review'
    })
    expect(out).toContain('roles: review')
    expect(out).not.toContain('- triage')
  })

  it('handles CRLF input', () => {
    const crlf = '---\r\ntitle: X\r\ncontributors:\r\n  - A <a@x.test> 2026-07-30\r\n---\r\nbody'
    expect(fmList(fmBlock(crlf)!.fm, 'contributors')).toEqual(['A <a@x.test> 2026-07-30'])
    expect(withFrontmatter(crlf, { author: 'B <b@x.test>' })).toContain(
      'contributors:\n  - A <a@x.test> 2026-07-30'
    )
  })
})
