import { describe, it, expect, vi } from 'vitest'
import { DefectCorpusService, type DefectCorpusDeps } from '../service'
import type { DefectCorpusSourceCfg } from '../../../../shared/defectCorpus'
import { SECRET_MASK, DefectCorpusClient, type CorpusAdminConfig } from '../client'

// Instrumented wrapper (not a behavior fake) — Finding 3 (final review, corpus-admin-editor)
// needs to assert what `timeoutMs` DefectCorpusService actually hands the client constructor
// for the admin-config path vs. the ordinary search/test/sync path. Delegating to the real
// class keeps every existing routedFetch-based test in this file working unmodified.
vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>()
  return {
    ...actual,
    // mockImplementation needs a real (non-arrow) constructor function so `new` inside
    // resolveClient still works.
    DefectCorpusClient: vi.fn().mockImplementation(function (
      this: unknown,
      opts: ConstructorParameters<typeof actual.DefectCorpusClient>[0]
    ) {
      return new actual.DefectCorpusClient(opts)
    })
  }
})

const ADMIN_CONFIG: CorpusAdminConfig = {
  jira: {
    baseUrl: 'https://x.atlassian.net',
    email: 'a@b.c',
    apiToken: SECRET_MASK,
    jql: 'project = KAN',
    includeComments: true
  },
  sync: { intervalMinutes: 60 },
  embedding: {
    endpoint: 'https://api.openai.com/v1',
    model: 'text-embedding-3-small',
    apiKey: SECRET_MASK
  },
  llm: { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: SECRET_MASK },
  enrichment: { mode: 'rules', rulesJql: 'resolution = Fixed' }
}

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
    timeoutMs?: number
  } = {}
): DefectCorpusDeps {
  const tokens = opts.tokens ?? {}
  return {
    sources: () => sources,
    token: (id) => tokens[id],
    fetchFn: opts.fetchFn,
    timeoutMs: opts.timeoutMs
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

  describe('getConfig()', () => {
    it('returns the parsed config on success', async () => {
      const sources: Record<string, DefectCorpusSourceCfg> = {
        s1: { name: 'S1', baseUrl: 'https://s1.example', enabled: true }
      }
      const fetchFn = routedFetch({
        'https://s1.example': () => ({ status: 200, json: ADMIN_CONFIG })
      })
      const svc = new DefectCorpusService(deps(sources, { tokens: { s1: 'tok' }, fetchFn }))
      expect(await svc.getConfig('s1')).toEqual({ ok: true, value: ADMIN_CONFIG })
    })

    it('maps a 404 not_configured envelope to {ok:false, code, error} with the envelope message', async () => {
      const sources: Record<string, DefectCorpusSourceCfg> = {
        s1: { name: 'S1', baseUrl: 'https://s1.example', enabled: true }
      }
      const fetchFn = routedFetch({
        'https://s1.example': () => ({
          status: 404,
          json: { error: { code: 'not_configured', message: 'no admin config set' } }
        })
      })
      const svc = new DefectCorpusService(deps(sources, { tokens: { s1: 'tok' }, fetchFn }))
      expect(await svc.getConfig('s1')).toEqual({
        ok: false,
        error: 'no admin config set',
        code: 'not_configured'
      })
    })

    it('short-circuits a missing token with zero fetch calls', async () => {
      const sources: Record<string, DefectCorpusSourceCfg> = {
        s1: { name: 'S1', baseUrl: 'https://s1.example', enabled: true }
      }
      const fetchSpy = vi.fn()
      const svc = new DefectCorpusService(
        deps(sources, { fetchFn: fetchSpy as unknown as typeof fetch })
      )
      expect(await svc.getConfig('s1')).toEqual({ ok: false, error: 'no token configured' })
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('short-circuits an unknown source id with zero fetch calls', async () => {
      const fetchSpy = vi.fn()
      const svc = new DefectCorpusService(
        deps({}, { fetchFn: fetchSpy as unknown as typeof fetch })
      )
      expect(await svc.getConfig('ghost')).toEqual({ ok: false, error: 'unknown source' })
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  describe('putConfig()', () => {
    it('forwards the exact body and returns the masked response', async () => {
      const sources: Record<string, DefectCorpusSourceCfg> = {
        s1: { name: 'S1', baseUrl: 'https://s1.example', enabled: true }
      }
      const body: CorpusAdminConfig = {
        ...ADMIN_CONFIG,
        jira: {
          baseUrl: 'https://x.atlassian.net',
          email: 'a@b.c',
          jql: 'project = KAN',
          includeComments: true
        },
        sync: { intervalMinutes: 30 }
      }
      let seenMethod = ''
      let seenBody = ''
      const fetchFn = routedFetch({
        'https://s1.example': (_url, init) => {
          seenMethod = init?.method ?? ''
          seenBody = String(init?.body ?? '')
          return { status: 200, json: { ...ADMIN_CONFIG, sync: { intervalMinutes: 30 } } }
        }
      })
      const svc = new DefectCorpusService(deps(sources, { tokens: { s1: 'tok' }, fetchFn }))
      const result = await svc.putConfig('s1', body)
      expect(seenMethod).toBe('PUT')
      expect(JSON.parse(seenBody)).toEqual(body)
      expect(result).toEqual({
        ok: true,
        value: { ...ADMIN_CONFIG, sync: { intervalMinutes: 30 } }
      })
    })

    it('short-circuits a missing token with zero fetch calls', async () => {
      const sources: Record<string, DefectCorpusSourceCfg> = {
        s1: { name: 'S1', baseUrl: 'https://s1.example', enabled: true }
      }
      const fetchSpy = vi.fn()
      const svc = new DefectCorpusService(
        deps(sources, { fetchFn: fetchSpy as unknown as typeof fetch })
      )
      expect(await svc.putConfig('s1', ADMIN_CONFIG)).toEqual({
        ok: false,
        error: 'no token configured'
      })
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('short-circuits an unknown source id with zero fetch calls', async () => {
      const fetchSpy = vi.fn()
      const svc = new DefectCorpusService(
        deps({}, { fetchFn: fetchSpy as unknown as typeof fetch })
      )
      expect(await svc.putConfig('ghost', ADMIN_CONFIG)).toEqual({
        ok: false,
        error: 'unknown source'
      })
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  describe('jqlPreview()', () => {
    it('returns {ok:true, value:{count,sample}} on success', async () => {
      const sources: Record<string, DefectCorpusSourceCfg> = {
        s1: { name: 'S1', baseUrl: 'https://s1.example', enabled: true }
      }
      const preview = { count: 12, sample: [{ key: 'KAN-5', summary: 'SIGSEGV on shutdown' }] }
      const fetchFn = routedFetch({
        'https://s1.example': () => ({ status: 200, json: preview })
      })
      const svc = new DefectCorpusService(deps(sources, { tokens: { s1: 'tok' }, fetchFn }))
      expect(await svc.jqlPreview('s1', 'project = KAN')).toEqual({ ok: true, value: preview })
    })

    it('maps a 400 invalid_jql envelope to {ok:false, code}', async () => {
      const sources: Record<string, DefectCorpusSourceCfg> = {
        s1: { name: 'S1', baseUrl: 'https://s1.example', enabled: true }
      }
      const fetchFn = routedFetch({
        'https://s1.example': () => ({
          status: 400,
          json: { error: { code: 'invalid_jql', message: 'field X does not exist' } }
        })
      })
      const svc = new DefectCorpusService(deps(sources, { tokens: { s1: 'tok' }, fetchFn }))
      expect(await svc.jqlPreview('s1', 'field X = 1')).toEqual({
        ok: false,
        error: 'field X does not exist',
        code: 'invalid_jql'
      })
    })

    it('short-circuits a missing token with zero fetch calls', async () => {
      const sources: Record<string, DefectCorpusSourceCfg> = {
        s1: { name: 'S1', baseUrl: 'https://s1.example', enabled: true }
      }
      const fetchSpy = vi.fn()
      const svc = new DefectCorpusService(
        deps(sources, { fetchFn: fetchSpy as unknown as typeof fetch })
      )
      expect(await svc.jqlPreview('s1', 'project = KAN')).toEqual({
        ok: false,
        error: 'no token configured'
      })
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('short-circuits an unknown source id with zero fetch calls', async () => {
      const fetchSpy = vi.fn()
      const svc = new DefectCorpusService(
        deps({}, { fetchFn: fetchSpy as unknown as typeof fetch })
      )
      expect(await svc.jqlPreview('ghost', 'project = KAN')).toEqual({
        ok: false,
        error: 'unknown source'
      })
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  // Finding 3 (final review, corpus-admin-editor): DEFAULT_TIMEOUT_MS in client.ts (5s) is a
  // case-open budget — too short for adminPutConfig/adminJqlPreview, which the corpus server
  // can take longer to answer (jql-preview runs a live tracker query). The admin-call path
  // (getConfig/putConfig/jqlPreview) must construct its client with a longer timeout, WITHOUT
  // breaking the existing test seam: a caller that already injects `deps.timeoutMs` (as every
  // other test in this file may) must keep getting exactly that value.
  describe('admin call timeout (Finding 3)', () => {
    const sources: Record<string, DefectCorpusSourceCfg> = {
      s1: { name: 'S1', baseUrl: 'https://s1.example', enabled: true }
    }
    const okFetch = routedFetch({
      'https://s1.example': () => ({ status: 200, json: ADMIN_CONFIG })
    })

    it('passes the longer admin timeout (30s) to the client for getConfig when deps.timeoutMs is unset', async () => {
      const svc = new DefectCorpusService(
        deps(sources, { tokens: { s1: 'tok' }, fetchFn: okFetch })
      )
      await svc.getConfig('s1')
      const ctorOpts = vi.mocked(DefectCorpusClient).mock.calls.at(-1)?.[0]
      expect(ctorOpts?.timeoutMs).toBe(30_000)
    })

    it('passes the longer admin timeout (30s) to the client for putConfig and jqlPreview too', async () => {
      const svc = new DefectCorpusService(
        deps(sources, { tokens: { s1: 'tok' }, fetchFn: okFetch })
      )
      await svc.putConfig('s1', ADMIN_CONFIG)
      expect(vi.mocked(DefectCorpusClient).mock.calls.at(-1)?.[0]?.timeoutMs).toBe(30_000)

      const previewFetch = routedFetch({
        'https://s1.example': () => ({ status: 200, json: { count: 1, sample: [] } })
      })
      const svc2 = new DefectCorpusService(
        deps(sources, { tokens: { s1: 'tok' }, fetchFn: previewFetch })
      )
      await svc2.jqlPreview('s1', 'project = KAN')
      expect(vi.mocked(DefectCorpusClient).mock.calls.at(-1)?.[0]?.timeoutMs).toBe(30_000)
    })

    it('leaves a non-admin call (search) without the admin timeout override', async () => {
      const searchFetch = routedFetch({
        'https://s1.example': () => ({ status: 200, json: { hits: [] } })
      })
      const svc = new DefectCorpusService(
        deps(sources, { tokens: { s1: 'tok' }, fetchFn: searchFetch })
      )
      await svc.searchAll({ query: 'x' })
      expect(vi.mocked(DefectCorpusClient).mock.calls.at(-1)?.[0]?.timeoutMs).toBeUndefined()
    })

    it('honors an explicit deps.timeoutMs (test seam) over the admin timeout — the precedence rule', async () => {
      const svc = new DefectCorpusService(
        deps(sources, { tokens: { s1: 'tok' }, fetchFn: okFetch, timeoutMs: 777 })
      )
      await svc.getConfig('s1')
      expect(vi.mocked(DefectCorpusClient).mock.calls.at(-1)?.[0]?.timeoutMs).toBe(777)
    })
  })
})
