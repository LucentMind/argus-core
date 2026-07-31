import { describe, it, expect } from 'vitest'
import { packFeedSchema, selectUpdate, type PackFeed } from '../feed'

const WIN = { platform: 'win32', arch: 'x64' }

function entry(over: Partial<PackFeed['versions'][number]> = {}): PackFeed['versions'][number] {
  return {
    version: '1.1.0',
    argusApi: '^1',
    platform: 'win-x64',
    url: 'https://vendor.example/p-1.1.0-win-x64.zip',
    sha256: 'a'.repeat(64),
    ...over
  }
}

describe('packFeedSchema', () => {
  it('parses a well-formed feed', () => {
    const parsed = packFeedSchema.parse({ id: 'sample', versions: [entry()] })
    expect(parsed.versions[0].version).toBe('1.1.0')
  })

  it('rejects a non-hex or wrong-length sha256', () => {
    expect(() =>
      packFeedSchema.parse({ id: 'sample', versions: [entry({ sha256: 'nothex' })] })
    ).toThrow(/sha256/)
    expect(() =>
      packFeedSchema.parse({ id: 'sample', versions: [entry({ sha256: 'a'.repeat(63) })] })
    ).toThrow(/sha256/)
  })

  it('rejects a malformed platform string', () => {
    expect(() =>
      packFeedSchema.parse({ id: 'sample', versions: [entry({ platform: 'windows' })] })
    ).toThrow(/platform/)
  })

  it('accepts an empty versions list', () => {
    expect(packFeedSchema.parse({ id: 'sample', versions: [] }).versions).toEqual([])
  })
})

describe('selectUpdate', () => {
  it('returns null when nothing is newer than what is installed', () => {
    const feed = packFeedSchema.parse({ id: 'sample', versions: [entry({ version: '1.0.0' })] })
    expect(selectUpdate(feed, { installedVersion: '1.0.0', host: WIN })).toBeNull()
  })

  it('picks the newest compatible entry', () => {
    const feed = packFeedSchema.parse({
      id: 'sample',
      versions: [
        entry({ version: '1.1.0' }),
        entry({ version: '1.3.0' }),
        entry({ version: '1.2.0' })
      ]
    })
    expect(selectUpdate(feed, { installedVersion: '1.0.0', host: WIN })?.version).toBe('1.3.0')
  })

  it('skips entries built for another platform', () => {
    const feed = packFeedSchema.parse({
      id: 'sample',
      versions: [entry({ version: '2.0.0', platform: 'mac-arm64' }), entry({ version: '1.1.0' })]
    })
    expect(selectUpdate(feed, { installedVersion: '1.0.0', host: WIN })?.version).toBe('1.1.0')
  })

  it('skips entries requiring a Core API this build does not implement', () => {
    // The load-bearing case for a versions LIST rather than a `latest` pointer: without this
    // filter, a user on an older Core is offered a 2.0.0 that installPack rejects at the API
    // gate — after a full download — and can never get the 1.x that would actually install.
    const feed = packFeedSchema.parse({
      id: 'sample',
      versions: [entry({ version: '2.0.0', argusApi: '^2' }), entry({ version: '1.1.0' })]
    })
    expect(selectUpdate(feed, { installedVersion: '1.0.0', host: WIN })?.version).toBe('1.1.0')
  })

  it('returns null when every newer entry is incompatible', () => {
    const feed = packFeedSchema.parse({
      id: 'sample',
      versions: [entry({ version: '2.0.0', argusApi: '^2' })]
    })
    expect(selectUpdate(feed, { installedVersion: '1.0.0', host: WIN })).toBeNull()
  })

  it('ignores entries whose version is not valid semver', () => {
    const feed = packFeedSchema.parse({
      id: 'sample',
      versions: [entry({ version: 'nightly' }), entry({ version: '1.1.0' })]
    })
    expect(selectUpdate(feed, { installedVersion: '1.0.0', host: WIN })?.version).toBe('1.1.0')
  })

  it('returns null when the INSTALLED version is not valid semver', () => {
    // Pack manifests type `version` as a free string, so this is reachable. Comparing against
    // it would throw; refusing to guess is the safe answer.
    const feed = packFeedSchema.parse({ id: 'sample', versions: [entry({ version: '1.1.0' })] })
    expect(selectUpdate(feed, { installedVersion: 'v1-final', host: WIN })).toBeNull()
  })
})
