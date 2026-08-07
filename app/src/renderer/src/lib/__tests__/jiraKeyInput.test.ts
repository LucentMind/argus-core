import { describe, it, expect } from 'vitest'
import { parseJiraKeyInput } from '../jiraKeyInput'

describe('parseJiraKeyInput', () => {
  it('passes a bare key through unchanged (after trim)', () => {
    expect(parseJiraKeyInput('PROJ-1234')).toBe('PROJ-1234')
    expect(parseJiraKeyInput('  PROJ-1234  ')).toBe('PROJ-1234')
  })

  it('extracts the key from a plain browse link', () => {
    expect(parseJiraKeyInput('https://foo.atlassian.net/browse/PROJ-1234')).toBe('PROJ-1234')
  })

  it('extracts the key from a browse link with a trailing slash, query, or fragment', () => {
    expect(parseJiraKeyInput('https://foo.atlassian.net/browse/PROJ-1234/')).toBe('PROJ-1234')
    expect(parseJiraKeyInput('https://foo.atlassian.net/browse/PROJ-1234?filter=1')).toBe(
      'PROJ-1234'
    )
    expect(parseJiraKeyInput('https://foo.atlassian.net/browse/PROJ-1234#comment-1')).toBe(
      'PROJ-1234'
    )
  })

  it('is case-insensitive on the scheme and host but preserves the key as captured', () => {
    expect(parseJiraKeyInput('HTTP://foo.atlassian.net/browse/PROJ-1234')).toBe('PROJ-1234')
  })

  it('trims surrounding whitespace on a link before matching', () => {
    expect(parseJiraKeyInput('  https://foo.atlassian.net/browse/PROJ-1234  ')).toBe('PROJ-1234')
  })

  it('passes a non-browse URL through unchanged (trimmed)', () => {
    expect(parseJiraKeyInput('https://foo.atlassian.net/jira/software/projects/PROJ')).toBe(
      'https://foo.atlassian.net/jira/software/projects/PROJ'
    )
  })

  it('passes garbage input through unchanged (trimmed)', () => {
    expect(parseJiraKeyInput('not a key')).toBe('not a key')
    expect(parseJiraKeyInput('')).toBe('')
  })
})
