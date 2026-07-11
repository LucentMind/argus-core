import { describe, it, expect } from 'vitest'
import {
  refTier,
  refTitle,
  parseRefSources,
  refBody,
  stampRefFile,
  type RefSource
} from '../refSync/refFrontmatter'

const src: RefSource = {
  url: 'https://x.atlassian.net/wiki/spaces/N/pages/123',
  pageId: '123',
  version: 4,
  lastSynced: '2026-07-10T00:00:00.000Z'
}

describe('stamp + parse round-trip', () => {
  it('stamps trust_tier confluence with a sources list and parses it back (LF and CRLF)', () => {
    const stamped = stampRefFile('# Routing\n\nbody\n', {
      title: 'Routing flow',
      sources: [src],
      now: new Date('2026-07-10T00:00:00Z')
    })
    expect(refTier(stamped)).toBe('confluence')
    expect(refTitle(stamped)).toBe('Routing flow')
    expect(stamped).toContain('last_updated: 2026-07-10')
    expect(parseRefSources(stamped)).toEqual([src])
    expect(refBody(stamped)).toBe('# Routing\n\nbody\n')
    expect(parseRefSources(stamped.replace(/\n/g, '\r\n'))).toEqual([src])
  })

  it('re-stamping strips any prior frontmatter from the body', () => {
    const once = stampRefFile('body', {
      title: 'T',
      sources: [src],
      now: new Date('2026-07-10T00:00:00Z')
    })
    const twice = stampRefFile(once, {
      title: 'T',
      sources: [src],
      now: new Date('2026-07-10T00:00:00Z')
    })
    expect(twice.match(/^---$/gm)?.length).toBe(2)
  })
})

describe('reading foreign files', () => {
  it('team-knowledge tier and missing frontmatter are surfaced, not crashed on', () => {
    expect(refTier('---\ntrust_tier: team-knowledge\n---\nx')).toBe('team-knowledge')
    expect(refTier('no frontmatter')).toBeNull()
    expect(parseRefSources('no frontmatter')).toEqual([])
    expect(refBody('no frontmatter')).toBe('no frontmatter')
  })
})
