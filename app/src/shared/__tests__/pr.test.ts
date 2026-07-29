import { describe, it, expect } from 'vitest'
import { parsePrRef, remoteRepoName, remoteToOwnerRepo } from '../pr'

describe('remoteRepoName', () => {
  it('returns the repo name for GitHub remotes in any shape', () => {
    expect(remoteRepoName('https://github.com/JiaweiHan88/HiveMindTest.git')).toBe('HiveMindTest')
    expect(remoteRepoName('git@github.com:acme/widget.git')).toBe('widget')
  })

  it('falls back to the last path segment minus .git for other hosts', () => {
    expect(remoteRepoName('https://gitlab.example.com/team/inner-tool.git')).toBe('inner-tool')
  })

  it('returns null for null/empty/junk', () => {
    expect(remoteRepoName(null)).toBeNull()
    expect(remoteRepoName('')).toBeNull()
    expect(remoteRepoName('///')).toBeNull()
  })
})

describe('remoteToOwnerRepo', () => {
  it('parses ssh, https, and scp-like GitHub remotes', () => {
    expect(remoteToOwnerRepo('git@github.com:acme/widget.git')).toEqual({
      owner: 'acme',
      repo: 'widget'
    })
    expect(remoteToOwnerRepo('https://github.com/acme/widget.git')).toEqual({
      owner: 'acme',
      repo: 'widget'
    })
    expect(remoteToOwnerRepo('ssh://git@github.com/acme/widget')).toEqual({
      owner: 'acme',
      repo: 'widget'
    })
    expect(remoteToOwnerRepo('https://github.com/acme/widget/')).toEqual({
      owner: 'acme',
      repo: 'widget'
    })
  })

  it('returns null for non-GitHub hosts and junk', () => {
    expect(remoteToOwnerRepo('git@gitlab.com:acme/widget.git')).toBeNull()
    expect(remoteToOwnerRepo('/local/path/repo')).toBeNull()
    expect(remoteToOwnerRepo('')).toBeNull()
  })
})

describe('parsePrRef', () => {
  it('parses a full GitHub PR url', () => {
    expect(parsePrRef('https://github.com/acme/widget/pull/42')).toEqual({
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42'
    })
  })

  it('tolerates trailing path and query', () => {
    expect(parsePrRef('https://github.com/acme/widget/pull/42/files?w=1')?.number).toBe(42)
  })

  it('parses owner/repo#N', () => {
    expect(parsePrRef('acme/widget#42')).toEqual({
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42'
    })
  })

  it('parses a bare number against a remote url', () => {
    expect(parsePrRef('42', 'git@github.com:acme/widget.git')?.owner).toBe('acme')
    expect(parsePrRef('#42', 'https://github.com/acme/widget.git')?.repo).toBe('widget')
  })

  it('returns null without a remote for a bare number, and for junk', () => {
    expect(parsePrRef('42')).toBeNull()
    expect(parsePrRef('not a pr')).toBeNull()
    expect(parsePrRef('https://gitlab.com/a/b/-/merge_requests/1')).toBeNull()
  })
})
