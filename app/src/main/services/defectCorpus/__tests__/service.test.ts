import { describe, it, expect, vi } from 'vitest'
import { DefectCorpusService, type DefectCorpusDeps } from '../service'
import type { DefectCorpusSourceCfg } from '../../../../shared/defectCorpus'

const REAL_INFO = {
  name: 'hindsight-argus88',
  contract: '1.0',
  projects: ['NAV', 'PLAT'],
  ticketCount: 4213,
  lastSyncAt: '2026-08-01T12:00:00.000Z',
  capabilities: {
    semantic: true,
    admin: false,
    enrichment: { distilled: 812, total: 4213 }
  }
}

/** Injected fetchFn that dispatches by the request's base origin — house style (see client.test.ts's fetchOf). */
function routedFetch(
  routes: Record<string, (url: string, init?: RequestInit) => { status: number; json: unknown }>
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const origin = new URL(url).origin
    const handler = routes[origin]
    if (!handler) throw new Error(`no route for ${origin}`)
    const { status, json } = handler(url, init)
    return new Response(JSON.stringify(json), { status })
  }) as unknown as typeof fetch
}

function deps(
  sources: Record<string, DefectCorpusSourceCfg>,
  opts: {
    tokens?: Record<string, string>
    fetchFn?: typeof fetch
  } = {}
): DefectCorpusDeps {
  const tokens = opts.tokens ?? {}
  return {
    sources: () => sources,
    token: (id) => tokens[id],
    fetchFn: opts.fetchFn
  }
}

describe('DefectCorpusService', () => {
  describe('searchAll', () => {
    it('isolates a per-source failure: one succeeds, one is unreachable, both present, stable order, never throws', async () => {
      // Insertion order deliberately not alphabetical, to prove output order tracks
      // settings key order rather than being re-sorted.
      const sources: Record<string, DefectCorpusSourceCfg> = {
        zeta: { name: 'Zeta Corpus', baseUrl: 'https://zeta.example', enabled: true },
        alpha: { name: 'Alpha Corpus', baseUrl: 'https://alpha.example', enabled: true }
      }
      const hit = {
        key: 'NAV-1',
        url: 'https://x.atlassian.net/browse/NAV-1',
        score: 0.9,
        matchedOn: 'lexical' as const,
        snippet: '…crashes…',
        record: {
          key: 'NAV-1',
          url: 'https://x.atlassian.net/browse/NAV-1',
          project: 'NAV',
          summary: 'Crash',
          description: 'It crashes.',
          status: 'Done',
          resolution: 'Fixed',
          components: [],
          labels: [],
          affectsVersions: [],
          fixVersions: [],
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-02T00:00:00.000Z',
          resolvedAt: null,
          links: [],
          commentCount: 0,
          distilled: null
        }
      }
      const fetchFn = routedFetch({
        'https://zeta.example': () => ({ status: 200, json: { hits: [hit] } })
        // alpha.example intentionally unrouted -> fetchFn throws -> CorpusError(unreachable)
      })
      const svc = new DefectCorpusService(
        deps(sources, { tokens: { zeta: 'tok-z', alpha: 'tok-a' }, fetchFn })
      )
      const results = await svc.searchAll({ query: 'crash' })
      expect(results).toHaveLength(2)
      expect(results.map((r) => r.sourceId)).toEqual(['zeta', 'alpha'])
      expect(results[0]).toEqual({
        sourceId: 'zeta',
        sourceName: 'Zeta Corpus',
        ok: true,
        hits: [hit]
      })
      expect(results[1].ok).toBe(false)
      expect(results[1].sourceId).toBe('alpha')
      expect(results[1].hits).toEqual([])
      expect(typeof (results[1] as { error: string }).error).toBe('string')
    })

    it('skips disabled sources entirely (not even reported as a failed entry)', async () => {
      const sources: Record<string, DefectCorpusSourceCfg> = {
        on: { name: 'On', baseUrl: 'https://on.example', enabled: true },
        off: { name: 'Off', baseUrl: 'https://off.example', enabled: false }
      }
      const fetchFn = routedFetch({
        'https://on.example': () => ({ status: 200, json: { hits: [] } })
      })
      const svc = new DefectCorpusService(
        deps(sources, { tokens: { on: 'tok', off: 'tok' }, fetchFn })
      )
      const results = await svc.searchAll({ query: 'x' })
      expect(results).toHaveLength(1)
      expect(results[0].sourceId).toBe('on')
    })

    it('short-circuits a missing token to ok:false without any network call', async () => {
      const sources: Record<string, DefectCorpusSourceCfg> = {
        noauth: { name: 'No Auth', baseUrl: 'https://noauth.example', enabled: true }
      }
      const fetchSpy = vi.fn()
      const svc = new DefectCorpusService(
        deps(sources, { tokens: {}, fetchFn: fetchSpy as unknown as typeof fetch })
      )
      const results = await svc.searchAll({ query: 'x' })
      expect(results).toEqual([
        {
          sourceId: 'noauth',
          sourceName: 'No Auth',
          ok: false,
          error: 'no token configured',
          hits: []
        }
      ])
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  describe('enabledSources', () => {
    it('lists only enabled sources with id/name/baseUrl, in settings key order', () => {
      const sources: Record<string, DefectCorpusSourceCfg> = {
        b: { name: 'B', baseUrl: 'https://b.example', enabled: true },
        a: { name: 'A', baseUrl: 'https://a.example', enabled: false },
        c: { name: 'C', baseUrl: 'https://c.example', enabled: true }
      }
      const svc = new DefectCorpusService(deps(sources))
      expect(svc.enabledSources()).toEqual([
        { id: 'b', name: 'B', baseUrl: 'https://b.example' },
        { id: 'c', name: 'C', baseUrl: 'https://c.example' }
      ])
    })
  })

  describe('test()', () => {
    it('maps a successful /v1/info to {ok:true, info}', async () => {
      const sources: Record<string, DefectCorpusSourceCfg> = {
        s1: { name: 'S1', baseUrl: 'https://s1.example', enabled: true }
      }
      const fetchFn = routedFetch({
        'https://s1.example': () => ({ status: 200, json: REAL_INFO })
      })
      const svc = new DefectCorpusService(deps(sources, { tokens: { s1: 'tok' }, fetchFn }))
      expect(await svc.test('s1')).toEqual({ ok: true, info: REAL_INFO })
    })

    it('maps a CorpusError (non-OK envelope) to {ok:false, error}', async () => {
      const sources: Record<string, DefectCorpusSourceCfg> = {
        s1: { name: 'S1', baseUrl: 'https://s1.example', enabled: true }
      }
      const fetchFn = routedFetch({
        'https://s1.example': () => ({
          status: 403,
          json: { error: { code: 'forbidden', message: 'admin scope required' } }
        })
      })
      const svc = new DefectCorpusService(deps(sources, { tokens: { s1: 'tok' }, fetchFn }))
      expect(await svc.test('s1')).toEqual({ ok: false, error: 'admin scope required' })
    })

    it('short-circuits an unknown source id without a network call', async () => {
      const fetchSpy = vi.fn()
      const svc = new DefectCorpusService(
        deps({}, { fetchFn: fetchSpy as unknown as typeof fetch })
      )
      const result = await svc.test('ghost')
      expect(result.ok).toBe(false)
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  describe('syncNow()', () => {
    it('surfaces the 404 not_configured envelope message', async () => {
      const sources: Record<string, DefectCorpusSourceCfg> = {
        s1: { name: 'S1', baseUrl: 'https://s1.example', enabled: true }
      }
      const fetchFn = routedFetch({
        'https://s1.example': () => ({
          status: 404,
          json: {
            error: { code: 'not_configured', message: 'admin tier not configured for this source' }
          }
        })
      })
      const svc = new DefectCorpusService(deps(sources, { tokens: { s1: 'tok' }, fetchFn }))
      expect(await svc.syncNow('s1')).toEqual({
        ok: false,
        error: 'admin tier not configured for this source'
      })
    })

    it('returns ok:true when the sync starts', async () => {
      const sources: Record<string, DefectCorpusSourceCfg> = {
        s1: { name: 'S1', baseUrl: 'https://s1.example', enabled: true }
      }
      const fetchFn = routedFetch({
        'https://s1.example': () => ({ status: 202, json: { started: true } })
      })
      const svc = new DefectCorpusService(deps(sources, { tokens: { s1: 'tok' }, fetchFn }))
      expect(await svc.syncNow('s1')).toEqual({ ok: true })
    })
  })

  describe('syncStatus()', () => {
    it('returns the parsed status on success', async () => {
      const sources: Record<string, DefectCorpusSourceCfg> = {
        s1: { name: 'S1', baseUrl: 'https://s1.example', enabled: true }
      }
      const status = {
        state: 'running',
        progress: { fetched: 10, upserted: 10, embedded: 5 },
        lastSyncAt: null,
        lastError: null
      }
      const fetchFn = routedFetch({
        'https://s1.example': () => ({ status: 200, json: status })
      })
      const svc = new DefectCorpusService(deps(sources, { tokens: { s1: 'tok' }, fetchFn }))
      expect(await svc.syncStatus('s1')).toEqual(status)
    })

    it('returns null (never throws) when the source errors out', async () => {
      const sources: Record<string, DefectCorpusSourceCfg> = {
        s1: { name: 'S1', baseUrl: 'https://s1.example', enabled: true }
      }
      const fetchFn = routedFetch({
        'https://s1.example': () => ({ status: 500, json: { oops: true } })
      })
      const svc = new DefectCorpusService(deps(sources, { tokens: { s1: 'tok' }, fetchFn }))
      expect(await svc.syncStatus('s1')).toBeNull()
    })

    it('returns null without a network call when no token is configured', async () => {
      const sources: Record<string, DefectCorpusSourceCfg> = {
        s1: { name: 'S1', baseUrl: 'https://s1.example', enabled: true }
      }
      const fetchSpy = vi.fn()
      const svc = new DefectCorpusService(
        deps(sources, { fetchFn: fetchSpy as unknown as typeof fetch })
      )
      expect(await svc.syncStatus('s1')).toBeNull()
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })
})
