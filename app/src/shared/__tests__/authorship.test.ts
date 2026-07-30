import { describe, it, expect } from 'vitest'
import { parseAuthorship, authorName, formatIdentity } from '../authorship'

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
