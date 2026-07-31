import { describe, expect, it } from 'vitest'
import { resolveLink, scanLinks } from '../mdLinks'

const KNOWN = ['jira-fields.md', 'INDEX.md', 'Routing.md']

describe('scanLinks', () => {
  it('finds a link and spans the whole construct', () => {
    const doc = 'see [Jira fields](jira-fields.md) here'
    expect(scanLinks(doc)).toEqual([{ from: 4, to: 33, target: 'jira-fields.md' }])
    expect(doc.slice(4, 33)).toBe('[Jira fields](jira-fields.md)')
  })

  it('finds several links on one line', () => {
    expect(scanLinks('[a](a.md) and [b](b.md)').map((l) => l.target)).toEqual(['a.md', 'b.md'])
  })

  it('handles an INDEX.md row verbatim', () => {
    const line = '- [Jira fields](jira-fields.md) — how fields map'
    expect(scanLinks(line).map((l) => l.target)).toEqual(['jira-fields.md'])
  })

  it('strips a title attribute from the target', () => {
    expect(scanLinks('[a](a.md "The A")').map((l) => l.target)).toEqual(['a.md'])
  })

  it('ignores an image', () => {
    expect(scanLinks('![alt](pic.png)')).toEqual([])
  })

  it('ignores a bare bracket pair with no target', () => {
    expect(scanLinks('[not a link] and (not a target)')).toEqual([])
  })

  it('does not run a link across a newline', () => {
    expect(scanLinks('[a\nb](c.md)')).toEqual([])
  })

  it('stays fast on a document full of unmatched brackets', () => {
    // Regression guard for the quadratic backtracking finding: the old regex took ~13.8s on
    // 200k unmatched `[`; 50k alone took well over a second. The linear scanner should finish
    // this in single-digit milliseconds. 1000ms is a generous bound to avoid flaking on a loaded
    // CI runner.
    const doc = '['.repeat(50_000)
    const start = performance.now()
    const result = scanLinks(doc)
    const elapsed = performance.now() - start
    expect(result).toEqual([])
    expect(elapsed).toBeLessThan(1000)
  })

  it('reports the whole construct even when the destination contains a balanced paren', () => {
    const doc = 'see [a](x(1).md) end'
    const links = scanLinks(doc)
    expect(links).toHaveLength(1)
    expect(links[0]?.target).toBe('x(1).md')
    const { from, to } = links[0]!
    expect(doc.slice(from, to)).toBe('[a](x(1).md)')
  })

  it('finds the outer link when the label contains a nested bracket pair', () => {
    const doc = '[see [a] here](x.md)'
    const links = scanLinks(doc)
    expect(links).toHaveLength(1)
    expect(links[0]?.target).toBe('x.md')
    const { from, to } = links[0]!
    expect(doc.slice(from, to)).toBe(doc)
  })

  it('keeps every reported span starting with `[` and ending with `)`', () => {
    const doc = 'see [a](a.md) and [b](b(nested).md "titled") then [see [c] here](c.md) plain text'
    const links = scanLinks(doc)
    expect(links.length).toBeGreaterThan(0)
    for (const { from, to } of links) {
      const span = doc.slice(from, to)
      expect(span.startsWith('[')).toBe(true)
      expect(span.endsWith(')')).toBe(true)
    }
  })
})

describe('resolveLink', () => {
  it('resolves a plain sibling', () => {
    expect(resolveLink('jira-fields.md', KNOWN)).toBe('jira-fields.md')
  })

  it('resolves through a relative prefix — only the basename matters', () => {
    expect(resolveLink('./jira-fields.md', KNOWN)).toBe('jira-fields.md')
    expect(resolveLink('../references/jira-fields.md', KNOWN)).toBe('jira-fields.md')
  })

  it('drops an anchor and a query', () => {
    expect(resolveLink('jira-fields.md#mapping', KNOWN)).toBe('jira-fields.md')
    expect(resolveLink('jira-fields.md?v=2', KNOWN)).toBe('jira-fields.md')
  })

  it('decodes percent escapes', () => {
    expect(resolveLink('jira%2Dfields.md', KNOWN)).toBe('jira-fields.md')
  })

  it('survives a malformed percent escape instead of throwing', () => {
    expect(resolveLink('%E0%A4%A.md', KNOWN)).toBeNull()
  })

  it('returns the KNOWN spelling when the case differs', () => {
    expect(resolveLink('routing.md', KNOWN)).toBe('Routing.md')
  })

  it('refuses anything that is not a sibling markdown file', () => {
    expect(resolveLink('https://example.com/a.md', KNOWN)).toBeNull()
    expect(resolveLink('//example.com/a.md', KNOWN)).toBeNull()
    expect(resolveLink('/etc/passwd.md', KNOWN)).toBeNull()
    expect(resolveLink('mailto:a@b.md', KNOWN)).toBeNull()
    expect(resolveLink('pic.png', KNOWN)).toBeNull()
    expect(resolveLink('', KNOWN)).toBeNull()
    expect(resolveLink('#anchor-only', KNOWN)).toBeNull()
  })

  it('returns null for a markdown sibling that does not exist — that is the warning case', () => {
    expect(resolveLink('deleted.md', KNOWN)).toBeNull()
  })

  it('does not let an encoded slash act as a path separator', () => {
    // `%2F` decoded before splitting would turn `a%2FINDEX.md` into a path whose basename is
    // `INDEX.md`, resolving to a file the raw markdown never named.
    expect(resolveLink('a%2FINDEX.md', KNOWN)).toBeNull()
    expect(resolveLink('a%2Fjira-fields.md', KNOWN)).toBeNull()
  })
})
