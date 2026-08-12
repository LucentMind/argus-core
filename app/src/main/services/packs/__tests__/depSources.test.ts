import { describe, it, expect } from 'vitest'
import { makeCandidateResolver } from '../depSources'
import type { HttpClient, HttpResponse } from '../packUpdates'
import type { GhClient } from '../ghClient'

const HOST = { platform: 'win32', arch: 'x64' }
const FEED = 'https://vendor.example/common.json'

function feedHttp(body: unknown): HttpClient {
  const respond = (): HttpResponse => ({
    status: 200,
    location: null,
    body: Buffer.from(JSON.stringify(body))
  })
  return {
    get: async () => respond(),
    getToFile: async () => {
      throw new Error('not used')
    }
  }
}

function entry(version: string, over: Record<string, unknown> = {}): object {
  return {
    version,
    argusApi: '^1',
    platform: 'win-x64',
    url: `https://vendor.example/common-${version}-win-x64.zip`,
    sha256: 'a'.repeat(64),
    ...over
  }
}

const noGh = {} as GhClient

describe('feed source', () => {
  const source = { kind: 'feed', updateUrl: FEED, origin: 'https://vendor.example' } as const

  it('picks the newest version satisfying the range', async () => {
    const http = feedHttp({
      id: 'common',
      versions: [entry('1.0.0'), entry('1.4.0'), entry('2.0.0')]
    })
    const r = await makeCandidateResolver({ http, gh: noGh, host: HOST }).resolve(
      'common',
      '^1.0.0',
      source
    )
    expect(r?.version).toBe('1.4.0')
    expect(r?.originLabel).toBe('vendor.example')
  })

  it('returns null when no version satisfies the range', async () => {
    const http = feedHttp({ id: 'common', versions: [entry('0.9.0')] })
    expect(
      await makeCandidateResolver({ http, gh: noGh, host: HOST }).resolve(
        'common',
        '^1.0.0',
        source
      )
    ).toBeNull()
  })

  it('skips an entry built for another platform', async () => {
    const http = feedHttp({
      id: 'common',
      versions: [entry('1.4.0', { platform: 'mac-arm64' }), entry('1.1.0')]
    })
    const r = await makeCandidateResolver({ http, gh: noGh, host: HOST }).resolve(
      'common',
      '^1.0.0',
      source
    )
    expect(r?.version).toBe('1.1.0')
  })

  it('skips an entry requiring an incompatible pack API', async () => {
    const http = feedHttp({
      id: 'common',
      versions: [entry('1.4.0', { argusApi: '^9' }), entry('1.1.0')]
    })
    const r = await makeCandidateResolver({ http, gh: noGh, host: HOST }).resolve(
      'common',
      '^1.0.0',
      source
    )
    expect(r?.version).toBe('1.1.0')
  })

  it('skips an entry served from a different origin than the declared feed', async () => {
    const http = feedHttp({
      id: 'common',
      versions: [
        entry('1.4.0', { url: 'https://elsewhere.example/common-1.4.0-win-x64.zip' }),
        entry('1.1.0')
      ]
    })
    const r = await makeCandidateResolver({ http, gh: noGh, host: HOST }).resolve(
      'common',
      '^1.0.0',
      source
    )
    expect(r?.version).toBe('1.1.0')
  })

  it('refuses a feed whose id does not match the dependency', async () => {
    const http = feedHttp({ id: 'somethingelse', versions: [entry('1.1.0')] })
    await expect(
      makeCandidateResolver({ http, gh: noGh, host: HOST }).resolve('common', '^1.0.0', source)
    ).rejects.toThrow(/common/)
  })
})
