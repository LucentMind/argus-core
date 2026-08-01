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

  describe('origin filtering (Fix 2)', () => {
    const PIN = 'https://vendor.example'

    it('skips an off-origin newest entry in favour of an on-origin older one', () => {
      // Without origin as part of selection, this newest-wins reduce would pick the 2.0.0 entry,
      // and `apply()` would then refuse the whole update instead of offering the 1.1.0 the user
      // could actually get — one bad (or hostile) entry must not block every other one.
      const feed = packFeedSchema.parse({
        id: 'sample',
        versions: [
          entry({ version: '2.0.0', url: 'https://cdn.example/sample-2.0.0-win-x64.zip' }),
          entry({ version: '1.1.0', url: `${PIN}/sample-1.1.0-win-x64.zip` })
        ]
      })
      expect(
        selectUpdate(feed, { installedVersion: '1.0.0', host: WIN, origin: PIN })?.version
      ).toBe('1.1.0')
    })

    it('skips an entry with a malformed url rather than throwing', () => {
      // `feedEntrySchema.url` is `z.string().url()`, which (in this zod version) validates by
      // calling `new URL()` itself — so a feed that actually went through `packFeedSchema.parse`
      // can never carry a `url` that `new URL()` rejects. `selectUpdate` takes a plain `PackFeed`
      // object, though, not a parse call, so nothing at the type level stops a malformed value
      // from reaching it directly — this is exactly the defensive case `origin == null || ...`
      // guards, exercised here by constructing the feed object literally instead of parsing it.
      const feed: PackFeed = {
        id: 'sample',
        versions: [entry({ version: '9.9.9', url: 'not a url at all' })]
      }
      expect(selectUpdate(feed, { installedVersion: '1.0.0', host: WIN, origin: PIN })).toBeNull()
    })

    it('does not filter by origin at all when none is given (existing callers unaffected)', () => {
      const feed = packFeedSchema.parse({
        id: 'sample',
        versions: [entry({ version: '1.1.0', url: 'https://anywhere.example/p-1.1.0-win-x64.zip' })]
      })
      expect(selectUpdate(feed, { installedVersion: '1.0.0', host: WIN })?.version).toBe('1.1.0')
    })
  })
})
