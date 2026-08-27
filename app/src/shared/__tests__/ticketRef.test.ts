import { describe, it, expect } from 'vitest'
import { parseTicketRef, splitGithubRef } from '../ticketRef'

const ok = (input: string): { provider: string; ref: string } => {
  const r = parseTicketRef(input)
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`)
  return r.value
}

describe('parseTicketRef — jira', () => {
  it('accepts a bare key', () => {
    expect(ok('NAVAPI-12345')).toEqual({ provider: 'jira', ref: 'NAVAPI-12345' })
  })

  it('extracts the key from a browse URL', () => {
    expect(ok('https://argus88.atlassian.net/browse/KAN-17')).toEqual({
      provider: 'jira',
      ref: 'KAN-17'
    })
  })

  it('passes unrecognised input through to jira unchanged', () => {
    // Preserves today's behaviour: anything unknown goes to Jira and 404s there,
    // which is a clearer error than a parser rejection the user cannot act on.
    expect(ok('total nonsense')).toEqual({ provider: 'jira', ref: 'total nonsense' })
  })
})

describe('parseTicketRef — github', () => {
  it('accepts owner/repo#123', () => {
    expect(ok('cli/cli#14189')).toEqual({ provider: 'github', ref: 'cli/cli#14189' })
  })

  it('accepts an issue URL', () => {
    expect(ok('https://github.com/cli/cli/issues/14189')).toEqual({
      provider: 'github',
      ref: 'cli/cli#14189'
    })
  })

  it('accepts an issue URL with a trailing fragment', () => {
    expect(ok('https://github.com/cli/cli/issues/14189#issuecomment-540551969')).toEqual({
      provider: 'github',
      ref: 'cli/cli#14189'
    })
  })

  it('tolerates dots and dashes in owner and repo', () => {
    expect(ok('my-org/my.repo#7')).toEqual({ provider: 'github', ref: 'my-org/my.repo#7' })
  })
})

describe('parseTicketRef — rejections', () => {
  it('rejects a pull request URL by name', () => {
    const r = parseTicketRef('https://github.com/cli/cli/pull/14222')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/pull request, not an issue/i)
  })

  it('rejects a bare #number with no repository', () => {
    const r = parseTicketRef('#123')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/owner\/repo#123/)
  })

  it('rejects owner/repo with no issue number', () => {
    const r = parseTicketRef('cli/cli')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/issue number/i)
  })

  it('rejects an empty input', () => {
    expect(parseTicketRef('   ').ok).toBe(false)
  })
})

describe('splitGithubRef', () => {
  it('splits a canonical ref', () => {
    expect(splitGithubRef('cli/cli#14189')).toEqual({ owner: 'cli', repo: 'cli', number: 14189 })
  })

  it('throws on a ref that is not github-shaped', () => {
    expect(() => splitGithubRef('KAN-17')).toThrow(/not a GitHub ref/i)
  })
})
