import { describe, it, expect } from 'vitest'
import { parseGhRef, sameGhRef, formatGhRef } from '../githubRef'

describe('parseGhRef', () => {
  it('defaults the host to github.com', () => {
    expect(parseGhRef('LucentMind/demo_pack')).toEqual({
      host: 'github.com',
      owner: 'LucentMind',
      repo: 'demo_pack'
    })
  })

  it('accepts an explicit enterprise host', () => {
    expect(parseGhRef('ghe.acme.com/platform/argus-pack-triage')).toEqual({
      host: 'ghe.acme.com',
      owner: 'platform',
      repo: 'argus-pack-triage'
    })
  })

  // The host segment is told apart from an owner by requiring a dot. A repo name MAY contain
  // dots, an owner may not — so this must parse as owner/repo, not host/owner.
  it('treats a dotted repo name as a repo, not a host', () => {
    expect(parseGhRef('lucentmind/demo.pack')).toEqual({
      host: 'github.com',
      owner: 'lucentmind',
      repo: 'demo.pack'
    })
  })

  it('trims surrounding whitespace', () => {
    expect(parseGhRef('  LucentMind/demo_pack  ')?.repo).toBe('demo_pack')
  })

  it.each(['', 'demo_pack', 'a/b/c/d', 'https://github.com/o/r', 'o/', '/r'])(
    'rejects %j',
    (bad) => {
      expect(parseGhRef(bad)).toBeNull()
    }
  )
})

describe('sameGhRef', () => {
  it('compares case-insensitively, because GitHub does', () => {
    expect(
      sameGhRef(
        { host: 'github.com', owner: 'LucentMind', repo: 'Demo_Pack' },
        { host: 'GitHub.com', owner: 'lucentmind', repo: 'demo_pack' }
      )
    ).toBe(true)
  })

  it('is false across hosts', () => {
    expect(
      sameGhRef(
        { host: 'github.com', owner: 'o', repo: 'r' },
        { host: 'ghe.acme.com', owner: 'o', repo: 'r' }
      )
    ).toBe(false)
  })
})

describe('formatGhRef', () => {
  it('omits the default host', () => {
    expect(formatGhRef({ host: 'github.com', owner: 'o', repo: 'r' })).toBe('o/r')
  })

  it('keeps a non-default host', () => {
    expect(formatGhRef({ host: 'ghe.acme.com', owner: 'o', repo: 'r' })).toBe('ghe.acme.com/o/r')
  })
})
