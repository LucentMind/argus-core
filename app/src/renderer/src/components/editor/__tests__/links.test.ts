import { describe, expect, it } from 'vitest'
import { linkTargetsOf } from '../extensions/links'

const KNOWN = ['jira-fields.md', 'INDEX.md']

describe('linkTargetsOf', () => {
  it('marks a resolvable link ok', () => {
    const doc = 'see [Jira](jira-fields.md)'
    expect(linkTargetsOf(doc, KNOWN)).toEqual([{ from: 4, to: 26, ok: true }])
  })

  it('marks an unresolvable one not ok, rather than dropping it', () => {
    // Dropping it is what makes a broken link invisible; the warning IS the feature.
    expect(linkTargetsOf('[gone](gone.md)', KNOWN)).toEqual([{ from: 0, to: 15, ok: false }])
  })

  it('marks an external link not ok', () => {
    expect(linkTargetsOf('[x](https://a.example/b.md)', KNOWN)[0]!.ok).toBe(false)
  })

  it('returns ranges in ascending order, which the range builder requires', () => {
    const out = linkTargetsOf('[a](INDEX.md) then [b](jira-fields.md)', KNOWN)
    expect(out.map((r) => r.from)).toEqual([0, 19])
  })

  it('finds nothing in a document with no links', () => {
    expect(linkTargetsOf('plain prose', KNOWN)).toEqual([])
  })
})
