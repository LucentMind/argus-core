import { describe, it, expect } from 'vitest'
import { CorpusError, DefectCorpusClient, SECRET_MASK } from '../client'

// Schema-conformant synthetic /v1/info fixture built to the values quoted in the
// plan's appendix note (`{"name":"hindsight-argus88","contract":"1.0",...}`) — NOT
// a byte-for-byte live capture. Used to verify the CorpusInfo schema round-trips a
// realistically-shaped response rather than a hand-rolled minimal shape.
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

/** Injected fetchFn returning a canned Response — house style (see atlassian.test.ts). */
function fetchOf(
  handler: (url: string, init?: RequestInit) => { status: number; json: unknown }
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const { status, json } = handler(url, init)
    return new Response(JSON.stringify(json), { status })
  }) as unknown as typeof fetch
}

const client = (fetchFn: typeof fetch, opts?: Partial<{ timeoutMs: number }>): DefectCorpusClient =>
  new DefectCorpusClient({ baseUrl: 'https://corpus.example', token: 'tok', fetchFn, ...opts })

describe('DefectCorpusClient', () => {
  it('exports SECRET_MASK', () => {
    expect(SECRET_MASK).toBe('••••••')
  })

  it('sends the bearer token and round-trips /v1/info against a real fixture', async () => {
    let seenAuth: string | undefined
    let seenUrl = ''
    const fetchFn = fetchOf((url, init) => {
      seenUrl = url
      seenAuth = (init?.headers as Record<string, string>)?.authorization
      return { status: 200, json: REAL_INFO }
    })
    const info = await client(fetchFn).info()
    expect(info).toEqual(REAL_INFO)
    expect(seenAuth).toBe('Bearer tok')
    expect(seenUrl).toBe('https://corpus.example/v1/info')
  })

  it('search() posts only the keys the caller provided (no mode/limit on a minimal request)', async () => {
    let seenBody = ''
    const fetchFn = fetchOf((_url, init) => {
      seenBody = String(init?.body ?? '')
      return { status: 200, json: { hits: [] } }
    })
    const res = await client(fetchFn).search({ query: 'crash on route recalc' })
    expect(res).toEqual({ hits: [] })
    const posted = JSON.parse(seenBody) as Record<string, unknown>
    expect(posted).toEqual({ query: 'crash on route recalc' })
    expect('mode' in posted).toBe(false)
    expect('limit' in posted).toBe(false)
  })

  it('search() posts mode/filters/limit when provided', async () => {
    let seenBody = ''
    const fetchFn = fetchOf((_url, init) => {
      seenBody = String(init?.body ?? '')
      return { status: 200, json: { hits: [] } }
    })
    await client(fetchFn).search({
      query: 'crash',
      mode: 'lexical',
      filters: { projects: ['NAV'], updatedAfter: '2025-01-01T00:00:00.000Z' },
      limit: 5
    })
    expect(JSON.parse(seenBody)).toEqual({
      query: 'crash',
      mode: 'lexical',
      filters: { projects: ['NAV'], updatedAfter: '2025-01-01T00:00:00.000Z' },
      limit: 5
    })
  })

  it('parses a search response with a full DefectRecord embedded in each hit', async () => {
    const record = {
      key: 'NAV-1',
      url: 'https://x.atlassian.net/browse/NAV-1',
      project: 'NAV',
      summary: 'Crash on route recalc',
      description: 'It crashes.',
      status: 'Done',
      resolution: 'Fixed',
      components: ['routing'],
      labels: [],
      affectsVersions: [],
      fixVersions: ['2.1'],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
      resolvedAt: null,
      links: [{ type: 'duplicates', key: 'NAV-9' }],
      commentCount: 2,
      distilled: null
    }
    const fetchFn = fetchOf(() => ({
      status: 200,
      json: {
        hits: [
          {
            key: 'NAV-1',
            url: record.url,
            score: 0.87,
            matchedOn: 'both',
            snippet: '…crashes…',
            record
          }
        ]
      }
    }))
    const res = await client(fetchFn).search({ query: 'crash' })
    expect(res.hits).toHaveLength(1)
    expect(res.hits[0].record).toEqual(record)
  })

  it('throws CorpusError with code/status from the error envelope on non-OK', async () => {
    const fetchFn = fetchOf(() => ({
      status: 403,
      json: { error: { code: 'forbidden', message: 'admin scope required' } }
    }))
    await expect(client(fetchFn).adminSyncStatus()).rejects.toMatchObject({
      name: 'CorpusError',
      code: 'forbidden',
      status: 403
    })
  })

  it('throws CorpusError code=http_error when non-OK and the body is not an error envelope', async () => {
    const fetchFn = fetchOf(() => ({ status: 500, json: { oops: true } }))
    await expect(client(fetchFn).info()).rejects.toMatchObject({ code: 'http_error', status: 500 })
  })

  it('throws CorpusError code=http_error when a non-OK body is not JSON at all (e.g. a gateway HTML error page)', async () => {
    const fetchFn = (async () =>
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' }
      })) as unknown as typeof fetch
    await expect(client(fetchFn).info()).rejects.toMatchObject({ code: 'http_error', status: 502 })
  })

  it('throws CorpusError code=invalid_response when a 200 body fails schema validation', async () => {
    const fetchFn = fetchOf(() => ({ status: 200, json: { nope: true } }))
    await expect(client(fetchFn).info()).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200
    })
  })

  it('throws CorpusError code=unreachable status=0 when fetchFn throws (network/timeout)', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    await expect(client(fetchFn).info()).rejects.toMatchObject({
      name: 'CorpusError',
      code: 'unreachable',
      status: 0
    })
  })

  it('is a real Error subclass', async () => {
    const fetchFn = fetchOf(() => ({ status: 500, json: {} }))
    try {
      await client(fetchFn).info()
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(Error)
      expect(e).toBeInstanceOf(CorpusError)
    }
  })

  it('URL-encodes the defect key', async () => {
    let seenUrl = ''
    const fetchFn = fetchOf((url) => {
      seenUrl = url
      return { status: 404, json: { error: { code: 'not_found', message: 'x' } } }
    })
    await expect(client(fetchFn).getDefect('NAV 1/x')).rejects.toMatchObject({ code: 'not_found' })
    expect(seenUrl).toBe('https://corpus.example/v1/defects/NAV%201%2Fx')
  })

  it('adminSync() posts to /v1/admin/sync and parses { started }', async () => {
    let seenUrl = ''
    let seenMethod = ''
    const fetchFn = fetchOf((url, init) => {
      seenUrl = url
      seenMethod = init?.method ?? ''
      return { status: 202, json: { started: true } }
    })
    expect(await client(fetchFn).adminSync()).toEqual({ started: true })
    expect(seenUrl).toBe('https://corpus.example/v1/admin/sync')
    expect(seenMethod).toBe('POST')
  })

  it('adminSyncStatus() parses a running sync with progress', async () => {
    const status = {
      state: 'running',
      progress: { fetched: 1200, upserted: 1180, embedded: 900 },
      lastSyncAt: '2026-08-01T12:00:00.000Z',
      lastError: null
    }
    const fetchFn = fetchOf(() => ({ status: 200, json: status }))
    expect(await client(fetchFn).adminSyncStatus()).toEqual(status)
  })

  it('applies the default 5s timeout via AbortSignal when none is supplied', async () => {
    let seenSignal: AbortSignal | undefined
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      seenSignal = init?.signal as AbortSignal
      return new Response(JSON.stringify(REAL_INFO), { status: 200 })
    }) as unknown as typeof fetch
    await client(fetchFn).info()
    expect(seenSignal).toBeInstanceOf(AbortSignal)
  })
})

describe('admin config', () => {
  it('adminGetConfig GETs /v1/admin/config with bearer auth and parses the masked config', async () => {
    const cfg = {
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
    let seenUrl = ''
    let seenAuth: string | undefined
    let seenMethod = ''
    const fetchFn = fetchOf((url, init) => {
      seenUrl = url
      seenAuth = (init?.headers as Record<string, string>)?.authorization
      seenMethod = init?.method ?? ''
      return { status: 200, json: cfg }
    })
    const got = await client(fetchFn).adminGetConfig()
    expect(seenUrl).toBe('https://corpus.example/v1/admin/config')
    expect(seenMethod).toBe('GET')
    expect(seenAuth).toBe('Bearer tok')
    expect(got.jira.apiToken).toBe(SECRET_MASK)
    expect(got.enrichment.mode).toBe('rules')
  })

  it('adminGetConfig maps the 404 envelope to CorpusError code not_configured', async () => {
    const fetchFn = fetchOf(() => ({
      status: 404,
      json: { error: { code: 'not_configured', message: 'no admin config set' } }
    }))
    await expect(client(fetchFn).adminGetConfig()).rejects.toMatchObject({
      name: 'CorpusError',
      code: 'not_configured',
      status: 404
    })
  })

  it('adminPutConfig PUTs exactly the given body and parses the masked response', async () => {
    // jira.apiToken is OMITTED entirely (keep the existing secret); llm.apiKey is a real
    // value (replace). The client must pass the body through unmodified — no injected or
    // stripped fields — since masking/merge semantics are the server's job (SPEC.md §4.5).
    const body = {
      jira: {
        baseUrl: 'https://x.atlassian.net',
        email: 'a@b.c',
        jql: 'project = KAN',
        includeComments: true
      },
      sync: { intervalMinutes: 30 },
      embedding: {
        endpoint: 'https://api.openai.com/v1',
        model: 'text-embedding-3-small',
        apiKey: SECRET_MASK
      },
      llm: {
        provider: 'anthropic' as const,
        model: 'claude-sonnet-5',
        apiKey: 'sk-real-secret-value'
      },
      enrichment: { mode: 'on-first-hit' as const }
    }
    const response = {
      jira: {
        baseUrl: 'https://x.atlassian.net',
        email: 'a@b.c',
        apiToken: SECRET_MASK,
        jql: 'project = KAN',
        includeComments: true
      },
      sync: { intervalMinutes: 30 },
      embedding: {
        endpoint: 'https://api.openai.com/v1',
        model: 'text-embedding-3-small',
        apiKey: SECRET_MASK
      },
      llm: { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: SECRET_MASK },
      enrichment: { mode: 'on-first-hit' }
    }
    let seenUrl = ''
    let seenMethod = ''
    let seenBody = ''
    const fetchFn = fetchOf((url, init) => {
      seenUrl = url
      seenMethod = init?.method ?? ''
      seenBody = String(init?.body ?? '')
      return { status: 200, json: response }
    })
    const got = await client(fetchFn).adminPutConfig(body)
    expect(seenUrl).toBe('https://corpus.example/v1/admin/config')
    expect(seenMethod).toBe('PUT')
    expect(JSON.parse(seenBody)).toEqual(body)
    expect(got.llm.apiKey).toBe(SECRET_MASK)
  })

  it('adminJqlPreview POSTs {jql} and parses count+sample; invalid_jql envelope maps to that code', async () => {
    let seenUrl = ''
    let seenMethod = ''
    let seenBody = ''
    const fetchFn = fetchOf((url, init) => {
      seenUrl = url
      seenMethod = init?.method ?? ''
      seenBody = String(init?.body ?? '')
      return {
        status: 200,
        json: { count: 12, sample: [{ key: 'KAN-5', summary: 'SIGSEGV on shutdown' }] }
      }
    })
    const res = await client(fetchFn).adminJqlPreview('project = KAN')
    expect(seenUrl).toBe('https://corpus.example/v1/admin/jql-preview')
    expect(seenMethod).toBe('POST')
    expect(JSON.parse(seenBody)).toEqual({ jql: 'project = KAN' })
    expect(res).toEqual({ count: 12, sample: [{ key: 'KAN-5', summary: 'SIGSEGV on shutdown' }] })

    const badFetchFn = fetchOf(() => ({
      status: 400,
      json: { error: { code: 'invalid_jql', message: 'field X does not exist' } }
    }))
    await expect(client(badFetchFn).adminJqlPreview('field X = 1')).rejects.toMatchObject({
      name: 'CorpusError',
      code: 'invalid_jql',
      status: 400
    })
  })
})
