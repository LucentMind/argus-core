import { describe, expect, it } from 'vitest'
import { findMentions, needlesFor, MENTION_CAP, MENTION_TEXT_MAX } from '../corpusSearch'

describe('needlesFor', () => {
  it('gives a reference both its filename and its stem', () => {
    expect(needlesFor({ kind: 'reference', name: 'jira-fields.md', title: '' })).toEqual([
      'jira-fields.md',
      'jira-fields'
    ])
  })

  it('adds a distinct title', () => {
    expect(needlesFor({ kind: 'reference', name: 'jira-fields.md', title: 'Jira fields' })).toEqual(
      ['jira-fields.md', 'jira-fields', 'Jira fields']
    )
  })

  it('does not repeat a title that only restates the stem', () => {
    expect(needlesFor({ kind: 'reference', name: 'jira-fields.md', title: 'jira-fields' })).toEqual(
      ['jira-fields.md', 'jira-fields']
    )
  })

  it('gives a skill its name alone — a skill has no filename to cite', () => {
    expect(needlesFor({ kind: 'skill', name: 'triage', title: '' })).toEqual(['triage'])
  })
})

describe('findMentions', () => {
  it('reports 1-indexed lines with their text', () => {
    const body = 'intro\nsee jira-fields.md for more\ntail'
    expect(findMentions(body, ['jira-fields.md'])).toEqual([
      { line: 2, text: 'see jira-fields.md for more' }
    ])
  })

  it('matches case-insensitively', () => {
    expect(findMentions('See JIRA-FIELDS.MD', ['jira-fields.md'])).toEqual([
      { line: 1, text: 'See JIRA-FIELDS.MD' }
    ])
  })

  it('reports a line once even when several needles hit it', () => {
    const body = 'jira-fields.md and Jira fields'
    expect(findMentions(body, ['jira-fields.md', 'Jira fields'])).toHaveLength(1)
  })

  it('will not match a needle inside a longer word', () => {
    // Otherwise every mention of "triage" also matches "triaged-cases" and the panel is noise.
    expect(findMentions('triaged the case', ['triage'])).toEqual([])
    expect(findMentions('run triage now', ['triage'])).toHaveLength(1)
  })

  it('handles CRLF without leaving a stray carriage return in the text', () => {
    expect(findMentions('a\r\nsee triage\r\nb', ['triage'])).toEqual([
      { line: 2, text: 'see triage' }
    ])
  })

  it('truncates a very long line', () => {
    const long = `${'x'.repeat(400)} triage`
    const [hit] = findMentions(long, ['triage'])
    expect(hit!.text).toHaveLength(MENTION_TEXT_MAX + 1) // the ellipsis
    expect(hit!.text.endsWith('…')).toBe(true)
  })

  it('caps how many lines one file may contribute', () => {
    const body = Array.from({ length: MENTION_CAP + 10 }, () => 'triage').join('\n')
    expect(findMentions(body, ['triage'])).toHaveLength(MENTION_CAP)
  })

  it('treats a regex-special needle literally', () => {
    expect(findMentions('see a.b.md here', ['a.b.md'])).toHaveLength(1)
    expect(findMentions('see axbxmd here', ['a.b.md'])).toEqual([])
  })

  it('returns nothing for an empty needle list', () => {
    expect(findMentions('anything', [])).toEqual([])
  })
})
