import { describe, it, expect } from 'vitest'
import {
  parseAuthorship,
  authorName,
  formatIdentity,
  stampAuthorship,
  CONTRIBUTOR_CAP
} from '../authorship'
import type { Identity } from '../authorship'

const file = [
  '---',
  'name: triage-a-flaky-test',
  'description: does a thing',
  'author: Jiawei Han <jiawiehan@gmail.com>',
  'origin: proposal',
  'contributors:',
  '  - Jiawei Han <jiawiehan@gmail.com> 2026-07-30',
  '  - Alex Chen <alex@example.test> 2026-08-02',
  '---',
  '# body\n'
].join('\n')

describe('parseAuthorship', () => {
  it('reads author, origin, and the dated contributor list', () => {
    const a = parseAuthorship(file)
    expect(a.author).toBe('Jiawei Han <jiawiehan@gmail.com>')
    expect(a.origin).toBe('proposal')
    expect(a.contributors).toEqual([
      { name: 'Jiawei Han', email: 'jiawiehan@gmail.com', date: '2026-07-30' },
      { name: 'Alex Chen', email: 'alex@example.test', date: '2026-08-02' }
    ])
  })

  it('returns an empty shape for a file with no frontmatter or no authorship', () => {
    expect(parseAuthorship('plain body')).toEqual({
      author: null,
      origin: null,
      contributors: []
    })
    expect(parseAuthorship('---\nname: x\n---\nbody')).toEqual({
      author: null,
      origin: null,
      contributors: []
    })
  })

  it('rejects an unknown origin rather than passing it through', () => {
    expect(parseAuthorship('---\nauthor: A <a@x.test>\norigin: smuggled\n---\nb').origin).toBeNull()
  })

  it('skips contributor lines it cannot parse', () => {
    const a = parseAuthorship(
      '---\ncontributors:\n  - garbage\n  - A <a@x.test> 2026-07-30\n---\nb'
    )
    expect(a.contributors).toEqual([{ name: 'A', email: 'a@x.test', date: '2026-07-30' }])
  })

  it('handles CRLF', () => {
    expect(parseAuthorship(file.replace(/\n/g, '\r\n')).author).toBe(
      'Jiawei Han <jiawiehan@gmail.com>'
    )
  })
})

describe('authorName', () => {
  it('strips the address and tolerates a bare name or null', () => {
    expect(authorName('Jiawei Han <jiawiehan@gmail.com>')).toBe('Jiawei Han')
    expect(authorName('Jiawei Han')).toBe('Jiawei Han')
    expect(authorName('<only@example.test>')).toBe('only@example.test')
    expect(authorName(null)).toBeNull()
    expect(authorName('   ')).toBeNull()
  })
})

describe('formatIdentity', () => {
  it('renders the canonical form', () => {
    expect(formatIdentity({ name: 'A B', email: 'a@x.test' })).toBe('A B <a@x.test>')
  })
})

describe('stampAuthorship', () => {
  const me: Identity = { name: 'Jiawei Han', email: 'jiawiehan@gmail.com' }
  const other: Identity = { name: 'Alex Chen', email: 'alex@example.test' }
  const day = (d: string): Date => new Date(`${d}T12:00:00Z`)
  const plain = '---\nname: x\ndescription: d\n---\n# body\n'

  it('returns the input untouched when there is no identity', () => {
    const out = stampAuthorship(plain, {
      identity: null,
      origin: 'authored',
      now: day('2026-07-30')
    })
    expect(out).toBe(plain)
  })

  it('stamps author, origin, and the first contributor on creation', () => {
    const out = stampAuthorship(plain, { identity: me, origin: 'proposal', now: day('2026-07-30') })
    const a = parseAuthorship(out)
    expect(a.author).toBe('Jiawei Han <jiawiehan@gmail.com>')
    expect(a.origin).toBe('proposal')
    expect(a.contributors).toEqual([
      { name: 'Jiawei Han', email: 'jiawiehan@gmail.com', date: '2026-07-30' }
    ])
    expect(out.endsWith('# body\n')).toBe(true)
    expect(out).toContain('name: x')
  })

  it('never rewrites an existing author or origin', () => {
    const first = stampAuthorship(plain, {
      identity: me,
      origin: 'proposal',
      now: day('2026-07-30')
    })
    const second = stampAuthorship(first, {
      identity: other,
      origin: 'authored',
      now: day('2026-08-02')
    })
    const a = parseAuthorship(second)
    expect(a.author).toBe('Jiawei Han <jiawiehan@gmail.com>')
    expect(a.origin).toBe('proposal')
    expect(a.contributors.map((c) => c.email)).toEqual(['jiawiehan@gmail.com', 'alex@example.test'])
  })

  it('a fork keeps the original author but claims origin', () => {
    const first = stampAuthorship(plain, {
      identity: me,
      origin: 'authored',
      now: day('2026-07-30')
    })
    const forked = stampAuthorship(first, {
      identity: other,
      origin: 'fork',
      now: day('2026-08-02')
    })
    const a = parseAuthorship(forked)
    expect(a.author).toBe('Jiawei Han <jiawiehan@gmail.com>')
    expect(a.origin).toBe('fork')
    expect(a.contributors.at(-1)).toEqual({
      name: 'Alex Chen',
      email: 'alex@example.test',
      date: '2026-08-02'
    })
  })

  it('a null origin appends a contributor without ever claiming authorship', () => {
    const out = stampAuthorship(plain, { identity: me, origin: null, now: day('2026-07-30') })
    const a = parseAuthorship(out)
    expect(a.author).toBeNull()
    expect(a.origin).toBeNull()
    expect(a.contributors).toEqual([
      { name: 'Jiawei Han', email: 'jiawiehan@gmail.com', date: '2026-07-30' }
    ])
  })

  it('is byte-identical when the same person stamps twice on the same day', () => {
    const once = stampAuthorship(plain, {
      identity: me,
      origin: 'authored',
      now: day('2026-07-30')
    })
    const twice = stampAuthorship(once, {
      identity: me,
      origin: 'authored',
      now: day('2026-07-30')
    })
    expect(twice).toBe(once)
  })

  it('upserts by email — a renamed engineer updates their entry, not a second one', () => {
    const first = stampAuthorship(plain, {
      identity: me,
      origin: 'authored',
      now: day('2026-07-30')
    })
    const renamed = stampAuthorship(first, {
      identity: { name: 'J. Han', email: 'jiawiehan@gmail.com' },
      origin: 'authored',
      now: day('2026-08-05')
    })
    expect(parseAuthorship(renamed).contributors).toEqual([
      { name: 'J. Han', email: 'jiawiehan@gmail.com', date: '2026-08-05' }
    ])
  })

  it('keeps contributor lines it cannot parse', () => {
    const withJunk = '---\nname: x\ncontributors:\n  - not a contributor line\n---\nbody\n'
    const out = stampAuthorship(withJunk, {
      identity: me,
      origin: null,
      now: day('2026-07-30')
    })
    expect(out).toContain('- not a contributor line')
    expect(parseAuthorship(out).contributors).toHaveLength(1)
  })

  it('caps the list, dropping the oldest', () => {
    let raw = plain
    for (let i = 0; i < CONTRIBUTOR_CAP + 3; i++) {
      raw = stampAuthorship(raw, {
        identity: { name: `P${i}`, email: `p${i}@x.test` },
        origin: 'authored',
        now: day('2026-07-30')
      })
    }
    const a = parseAuthorship(raw)
    expect(a.contributors).toHaveLength(CONTRIBUTOR_CAP)
    expect(a.contributors[0].email).toBe('p3@x.test')
    // the author key is not a list entry, so the trim cannot lose it
    expect(a.author).toBe('P0 <p0@x.test>')
  })

  it('creates a frontmatter block when the file has none', () => {
    const out = stampAuthorship('plain body', {
      identity: me,
      origin: 'authored',
      now: day('2026-07-30')
    })
    expect(out.startsWith('---\n')).toBe(true)
    expect(out.endsWith('plain body')).toBe(true)
    expect(parseAuthorship(out).author).toBe('Jiawei Han <jiawiehan@gmail.com>')
  })
})
