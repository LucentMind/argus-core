import { describe, it, expect, vi } from 'vitest'
import { DefectCorpusService } from '../../defectCorpus/service'
import { createCorpusProviders } from '../providers/corpus'
import { freeFormQuery } from '../query'
import type { CorpusDefectHit } from '../../../../shared/relatedHistory'

function hit(key: string, over: Record<string, unknown> = {}): unknown {
  return {
    key,
    url: `https://corpus.example/browse/${key}`,
    score: 0.9,
    matchedOn: 'semantic',
    snippet: '«charge»',
    record: {
      key,
      url: `https://corpus.example/browse/${key}`,
      project: 'KAN',
      summary: `summary of ${key}`,
      description: 'desc',
      status: 'Done',
      resolution: 'Fixed',
      components: [],
      labels: [],
      affectsVersions: [],
      fixVersions: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      resolvedAt: '2026-01-03T00:00:00Z',
      links: [],
      commentCount: 0,
      distilled: null,
      ...over
    }
  }
}

function svc(opts: {
  sources?: Record<string, { name: string; baseUrl: string; enabled: boolean }>
  fetchFn?: typeof fetch
}): DefectCorpusService {
  return new DefectCorpusService({
    sources: () =>
      opts.sources ?? { src1: { name: 'Hindsight', baseUrl: 'https://c1', enabled: true } },
    token: () => 'tok',
    fetchFn: opts.fetchFn
  })
}

const okFetch = (hits: unknown[]): typeof fetch =>
  vi.fn(
    async () => new Response(JSON.stringify({ hits }), { status: 200 })
  ) as unknown as typeof fetch

describe('DefectCorpusService.searchOne', () => {
  it('searches exactly one source', async () => {
    const s = svc({ fetchFn: okFetch([hit('KAN-5')]) })
    const r = await s.searchOne('src1', undefined, { query: 'charge' })
    expect(r.ok).toBe(true)
    expect(r.sourceId).toBe('src1')
    expect(r.hits).toHaveLength(1)
  })

  it('reports an unknown source and a missing token without a network call', async () => {
    const fetchFn = okFetch([])
    const s = new DefectCorpusService({
      sources: () => ({ src1: { name: 'H', baseUrl: 'https://c1', enabled: true } }),
      token: () => undefined,
      fetchFn
    })
    expect((await s.searchOne('nope', undefined, { query: 'x' })).error).toBe('unknown source')
    expect((await s.searchOne('src1', undefined, { query: 'x' })).error).toBe('no token configured')
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('createCorpusProviders', () => {
  it('yields one provider per enabled source, in settings order', () => {
    const providers = createCorpusProviders(
      svc({
        sources: {
          a: { name: 'A', baseUrl: 'https://a', enabled: true },
          b: { name: 'B', baseUrl: 'https://b', enabled: false },
          c: { name: 'C', baseUrl: 'https://c', enabled: true }
        }
      })
    )
    expect(providers.map((p) => p.id)).toEqual(['corpus:a', 'corpus:c'])
    expect(providers.map((p) => p.name)).toEqual(['A', 'C'])
    expect(providers.every((p) => p.kind === 'corpus')).toBe(true)
  })

  it('maps a hit to a CorpusDefectHit, taking rank from position not score', async () => {
    const providers = createCorpusProviders(
      svc({
        fetchFn: okFetch([
          hit('KAN-5', {
            distilled: {
              signature: 'sig',
              symptoms: 'sym',
              rootCause: 'rc',
              fix: 'fx',
              errorStrings: ['E_1'],
              distilledAt: 'x'
            }
          }),
          hit('KAN-8', { resolution: null, status: 'In Progress' })
        ])
      })
    )
    const r = await providers[0].search(freeFormQuery('charge'), 5)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const [first, second] = r.hits as CorpusDefectHit[]

    expect(first.kind).toBe('corpus')
    expect(first.id).toBe('corpus:src1:KAN-5')
    expect(first.sourceId).toBe('src1')
    expect(first.key).toBe('KAN-5')
    expect(first.url).toBe('https://corpus.example/browse/KAN-5')
    expect(first.rank).toBe(1)
    expect(first.matchedOn).toBe('semantic')
    expect(first.title).toBe('summary of KAN-5')
    expect(first.snippet).toBe('«charge»')
    expect(first.status).toEqual({ label: 'Done / Fixed', tone: 'resolved' })
    expect(first.distilled).toEqual({
      signature: 'sig',
      symptoms: 'sym',
      rootCause: 'rc',
      fix: 'fx',
      terms: ['E_1']
    })
    expect(first.provenance).toEqual([
      { providerId: 'corpus:src1', providerName: 'Hindsight', kind: 'corpus' }
    ])

    expect(second.rank).toBe(2)
    expect(second.status).toEqual({ label: 'In Progress', tone: 'open' })
    expect(second.distilled).toBeNull()
  })

  it('sends the query text and limit, and no mode or filters in increment 1', async () => {
    const fetchFn = okFetch([])
    const providers = createCorpusProviders(svc({ fetchFn }))
    await providers[0].search(freeFormQuery('charge plan'), 3)
    const body = JSON.parse((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body).toEqual({ query: 'charge plan', limit: 3 })
  })

  it('surfaces a source failure as ok:false with the CorpusError code', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'forbidden', message: 'nope' } }), {
          status: 403
        })
    ) as unknown as typeof fetch
    const providers = createCorpusProviders(svc({ fetchFn }))
    const r = await providers[0].search(freeFormQuery('x'), 5)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('nope')
      expect(r.code).toBe('forbidden')
    }
  })
})
