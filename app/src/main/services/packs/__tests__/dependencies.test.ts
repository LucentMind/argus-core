import { describe, it, expect } from 'vitest'
import { normalizeDependencies } from '../dependencies'

describe('normalizeDependencies', () => {
  it('returns an empty list for undefined', () => {
    expect(normalizeDependencies(undefined)).toEqual([])
  })

  it('normalises a bare string to a sourceless dependency', () => {
    expect(normalizeDependencies({ common: '^1.2' })).toEqual([
      { id: 'common', range: '^1.2', source: null }
    ])
  })

  it('normalises updateRepo to a github source', () => {
    expect(normalizeDependencies({ common: { range: '^1', updateRepo: 'org/packs' } })).toEqual([
      {
        id: 'common',
        range: '^1',
        source: { kind: 'github', host: 'github.com', owner: 'org', repo: 'packs' }
      }
    ])
  })

  it('normalises updateUrl to a feed source carrying its origin', () => {
    expect(
      normalizeDependencies({ tiles: { range: '~0.4', updateUrl: 'https://v.example/a/t.json' } })
    ).toEqual([
      {
        id: 'tiles',
        range: '~0.4',
        source: {
          kind: 'feed',
          updateUrl: 'https://v.example/a/t.json',
          origin: 'https://v.example'
        }
      }
    ])
  })

  it('normalises an object entry with neither source to null', () => {
    expect(normalizeDependencies({ common: { range: '^1' } })).toEqual([
      { id: 'common', range: '^1', source: null }
    ])
  })

  it('preserves declaration order across mixed forms', () => {
    const out = normalizeDependencies({
      common: { range: '^1', updateRepo: 'org/packs' },
      legacy: '^3'
    })
    expect(out.map((d) => d.id)).toEqual(['common', 'legacy'])
  })
})
