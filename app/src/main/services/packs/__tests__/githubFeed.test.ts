import { describe, it, expect } from 'vitest'
import { findGithubUpdate, RepoMovedError } from '../githubFeed'
import { GhError, type GhClient } from '../ghClient'
import type { GithubPackSource } from '../packsState'

const WIN = { platform: 'win32', arch: 'x64' }
const PIN: GithubPackSource = {
  kind: 'github',
  host: 'github.com',
  owner: 'LucentMind',
  repo: 'demo_pack',
  installedAt: 0
}
const SHA = 'a'.repeat(64)

function release(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v1.1.0',
    draft: false,
    prerelease: false,
    html_url: 'https://github.com/LucentMind/demo_pack/releases/tag/v1.1.0',
    assets: [
      {
        name: 'sample-1.1.0-win-x64.zip',
        size: 4978,
        digest: `sha256:${SHA}`,
        browser_download_url:
          'https://github.com/LucentMind/demo_pack/releases/download/v1.1.0/sample-1.1.0-win-x64.zip'
      }
    ],
    ...over
  }
}

/** Records every API path so a test can assert what was NOT fetched. */
function fakeGh(routes: Record<string, unknown>): GhClient & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    api: async (_ref, path) => {
      calls.push(path)
      const key = Object.keys(routes).find((k) => path.startsWith(k))
      if (!key) throw new GhError('notfound', `no route for ${path}`)
      return routes[key]
    },
    downloadAsset: async () => {
      throw new Error('not used here')
    }
  }
}

const manifestContents = (body: Record<string, unknown>): Record<string, unknown> => ({
  content: Buffer.from(JSON.stringify(body)).toString('base64'),
  encoding: 'base64'
})

describe('findGithubUpdate', () => {
  it('builds a candidate from a release asset, taking sha256 from the digest', async () => {
    const gh = fakeGh({
      'repos/LucentMind/demo_pack/releases': [release()],
      'repos/LucentMind/demo_pack/git/trees': {
        tree: [{ path: 'packs/sample/argus-pack.json', type: 'blob' }]
      },
      'repos/LucentMind/demo_pack/contents': manifestContents({
        id: 'sample',
        version: '1.1.0',
        argusApi: '^1'
      })
    })
    const found = await findGithubUpdate({ gh, host: WIN }, PIN, 'sample', '1.0.0')
    expect(found?.candidate.entry).toMatchObject({
      version: '1.1.0',
      platform: 'win-x64',
      sha256: SHA
    })
    expect(found?.candidate.tag).toBe('v1.1.0')
    expect(found?.candidate.assetName).toBe('sample-1.1.0-win-x64.zip')
    expect(found?.manifestPath).toBe('packs/sample/argus-pack.json')
  })

  // The single most important budget property: a check that finds nothing newer must cost ONE
  // API call. Hydrating argusApi for every release would make checkAll proportional to release
  // history rather than to installed packs.
  it('never reads a manifest when nothing is newer', async () => {
    const gh = fakeGh({ 'repos/LucentMind/demo_pack/releases': [release()] })
    const found = await findGithubUpdate({ gh, host: WIN }, PIN, 'sample', '1.1.0')
    expect(found).toBeNull()
    expect(gh.calls).toHaveLength(1)
    expect(gh.calls[0]).toContain('/releases')
  })

  it('ignores drafts and prereleases', async () => {
    const gh = fakeGh({
      'repos/LucentMind/demo_pack/releases': [
        release({ tag_name: 'v2.0.0', draft: true, assets: [] }),
        release({ tag_name: 'v1.9.0', prerelease: true, assets: [] }),
        release()
      ],
      'repos/LucentMind/demo_pack/git/trees': {
        tree: [{ path: 'packs/sample/argus-pack.json', type: 'blob' }]
      },
      'repos/LucentMind/demo_pack/contents': manifestContents({
        id: 'sample',
        version: '1.1.0',
        argusApi: '^1'
      })
    })
    const found = await findGithubUpdate({ gh, host: WIN }, PIN, 'sample', '1.0.0')
    expect(found?.candidate.entry.version).toBe('1.1.0')
  })

  it('skips an asset with no digest rather than installing an unverifiable bundle', async () => {
    const gh = fakeGh({
      'repos/LucentMind/demo_pack/releases': [
        release({
          assets: [
            {
              name: 'sample-1.1.0-win-x64.zip',
              size: 10,
              digest: null,
              browser_download_url: 'https://github.com/LucentMind/demo_pack/x.zip'
            }
          ]
        })
      ]
    })
    expect(await findGithubUpdate({ gh, host: WIN }, PIN, 'sample', '1.0.0')).toBeNull()
  })

  it('ignores another pack’s assets in the same release', async () => {
    const gh = fakeGh({
      'repos/LucentMind/demo_pack/releases': [
        release({
          assets: [
            {
              name: 'other-pack-2.0.0-win-x64.zip',
              size: 10,
              digest: `sha256:${SHA}`,
              browser_download_url: 'https://github.com/LucentMind/demo_pack/o.zip'
            }
          ]
        })
      ]
    })
    expect(await findGithubUpdate({ gh, host: WIN }, PIN, 'sample', '1.0.0')).toBeNull()
  })

  // Both a pack id and a semver prerelease may contain hyphens. Splitting on hyphens would
  // advertise version `beta.1` for `code-graph-1.1.0-beta.1-win-x64.zip`.
  it('separates a hyphenated id from a hyphenated version by the known id', async () => {
    const gh = fakeGh({
      'repos/LucentMind/demo_pack/releases': [
        release({
          assets: [
            {
              name: 'code-graph-1.1.0-beta.1-win-x64.zip',
              size: 10,
              digest: `sha256:${SHA}`,
              browser_download_url: 'https://github.com/LucentMind/demo_pack/c.zip'
            }
          ]
        })
      ],
      'repos/LucentMind/demo_pack/git/trees': {
        tree: [{ path: 'argus-pack.json', type: 'blob' }]
      },
      'repos/LucentMind/demo_pack/contents': manifestContents({
        id: 'code-graph',
        version: '1.1.0-beta.1',
        argusApi: '^1'
      })
    })
    const found = await findGithubUpdate({ gh, host: WIN }, PIN, 'code-graph', '1.0.0')
    expect(found?.candidate.entry.version).toBe('1.1.0-beta.1')
  })

  it('offers an older compatible release when the newest needs a newer Core', async () => {
    const gh = fakeGh({
      'repos/LucentMind/demo_pack/releases': [
        release({
          tag_name: 'v3.0.0',
          html_url: 'https://github.com/LucentMind/demo_pack/releases/tag/v3.0.0',
          assets: [
            {
              name: 'sample-3.0.0-win-x64.zip',
              size: 10,
              digest: `sha256:${SHA}`,
              browser_download_url: 'https://github.com/LucentMind/demo_pack/3.zip'
            }
          ]
        }),
        release()
      ],
      'repos/LucentMind/demo_pack/git/trees': {
        tree: [{ path: 'argus-pack.json', type: 'blob' }]
      }
    })
    // Two different manifests by ref: v3 needs a Core this build is not.
    const original = gh.api
    gh.api = async (ref, path) => {
      if (path.includes('contents')) {
        return path.includes('v3.0.0')
          ? manifestContents({ id: 'sample', version: '3.0.0', argusApi: '^99' })
          : manifestContents({ id: 'sample', version: '1.1.0', argusApi: '^1' })
      }
      return original(ref, path)
    }
    const found = await findGithubUpdate({ gh, host: WIN }, PIN, 'sample', '1.0.0')
    expect(found?.candidate.entry.version).toBe('1.1.0')
  })

  // The gh-path analogue of the feed path's redirect refusal: a renamed or transferred repo
  // answers under its OLD name but reports its NEW one, so the response itself gives it away.
  it('refuses a repo that has been renamed or transferred', async () => {
    const gh = fakeGh({
      'repos/LucentMind/demo_pack/releases': [
        release({ html_url: 'https://github.com/OtherOrg/demo_pack/releases/tag/v1.1.0' })
      ]
    })
    await expect(
      findGithubUpdate({ gh, host: WIN }, PIN, 'sample', '1.0.0')
    ).rejects.toBeInstanceOf(RepoMovedError)
  })

  it('tries the pinned manifest path before searching the tree', async () => {
    const gh = fakeGh({
      'repos/LucentMind/demo_pack/releases': [release()],
      'repos/LucentMind/demo_pack/contents': manifestContents({
        id: 'sample',
        version: '1.1.0',
        argusApi: '^1'
      })
    })
    const pinned = { ...PIN, manifestPath: 'packs/sample/argus-pack.json' }
    const found = await findGithubUpdate({ gh, host: WIN }, pinned, 'sample', '1.0.0')
    expect(found?.candidate.entry.version).toBe('1.1.0')
    expect(gh.calls.some((c) => c.includes('git/trees'))).toBe(false)
  })

  it('falls back to a tree search when the pinned path holds a different pack', async () => {
    const gh = fakeGh({
      'repos/LucentMind/demo_pack/releases': [release()],
      'repos/LucentMind/demo_pack/git/trees': {
        tree: [
          { path: 'packs/moved-sample/argus-pack.json', type: 'blob' },
          { path: 'packs/sample/argus-pack.json', type: 'blob' }
        ]
      }
    })
    const original = gh.api
    gh.api = async (ref, path) => {
      if (path.includes('contents')) {
        return path.includes('moved-sample')
          ? manifestContents({ id: 'sample', version: '1.1.0', argusApi: '^1' })
          : manifestContents({ id: 'somebody-else', version: '9.9.9', argusApi: '^1' })
      }
      return original(ref, path)
    }
    const stale = { ...PIN, manifestPath: 'packs/sample/argus-pack.json' }
    const found = await findGithubUpdate({ gh, host: WIN }, stale, 'sample', '1.0.0')
    expect(found?.manifestPath).toBe('packs/moved-sample/argus-pack.json')
  })

  it('ignores a release whose asset targets another platform', async () => {
    const gh = fakeGh({
      'repos/LucentMind/demo_pack/releases': [
        release({
          assets: [
            {
              name: 'sample-1.1.0-mac-arm64.zip',
              size: 10,
              digest: `sha256:${SHA}`,
              browser_download_url: 'https://github.com/LucentMind/demo_pack/m.zip'
            }
          ]
        })
      ]
    })
    expect(await findGithubUpdate({ gh, host: WIN }, PIN, 'sample', '1.0.0')).toBeNull()
  })
})
