import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fetchCatalog, catalogFor, clearCatalogCache } from '../catalog'
import type { CreateQueryFn } from '../index'
import fixture from '../__fixtures__/models-2-1-220.json'

function fakeQuery(
  models: unknown,
  opts: {
    throws?: boolean
    hang?: boolean
    hangInterrupt?: boolean
    throwsInterruptSync?: boolean
  } = {}
): CreateQueryFn {
  return vi.fn(() => ({
    supportedModels: async () => {
      if (opts.throws) throw new Error('CLI not found')
      if (opts.hang) await new Promise(() => undefined)
      return models
    },
    // A real hung CLI's control channel never answers interrupt() either — this is what
    // reproduces Finding 1 (ask()'s cleanup previously awaited this with no timeout at
    // all, so `q?.interrupt?.()` never settling meant `ask()` — and everything awaiting
    // it, up to CaseSession.stop() — never settled).
    interrupt: opts.hangInterrupt
      ? () => new Promise<void>(() => undefined)
      : opts.throwsInterruptSync
        ? // Reproduces the other half of Finding 1: a synchronous throw out of the
          // `finally` block's cleanup (not a rejected promise — a real throw before any
          // promise is even formed) is not caught by ask()'s try/catch, since that catch
          // only guards the try block. Left unguarded, this replaces whatever the try
          // block was about to return with a rejection.
          () => {
            throw new Error('interrupt() threw synchronously')
          }
        : async () => undefined,
    // Never iterated — ask() returns before consuming this once supportedModels is found.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    [Symbol.asyncIterator]: async function* () {}
  }))
}

beforeEach(() => clearCatalogCache())

describe('fetchCatalog', () => {
  it('returns the reported models', async () => {
    const models = await fetchCatalog(fakeQuery(fixture))
    expect(models.map((m) => m.value)).toContain('fable')
  })

  it('falls back to the static catalog when the CLI throws', async () => {
    const models = await fetchCatalog(fakeQuery(null, { throws: true }))
    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.value.startsWith('claude-'))).toBe(true)
  })

  it('falls back rather than hanging when the CLI never answers', async () => {
    const models = await fetchCatalog(fakeQuery(null, { hang: true }), { timeoutMs: 20 })
    expect(models.length).toBeGreaterThan(0)
  })

  it('caches, so a second call does not respawn the CLI', async () => {
    const q = fakeQuery(fixture)
    await fetchCatalog(q)
    await fetchCatalog(q)
    expect(q).toHaveBeenCalledTimes(1)
  })

  it('caches per cliPath, since a different binary is a different catalog', async () => {
    const q = fakeQuery(fixture)
    await fetchCatalog(q, { cliPath: '/a/claude' })
    await fetchCatalog(q, { cliPath: '/b/claude' })
    expect(q).toHaveBeenCalledTimes(2)
  })

  // Finding 1: the cleanup interrupt() had no timeout at all, so a truly hung CLI (one
  // whose control channel never answers) made ask() — and therefore anything awaiting
  // it, up to CaseSession.stop() — hang indefinitely, not merely for `timeoutMs`.
  it('resolves within a bound even when interrupt() never settles (a truly hung CLI)', async () => {
    const start = Date.now()
    const models = await fetchCatalog(fakeQuery(null, { throws: true, hangInterrupt: true }), {
      timeoutMs: 20
    })
    expect(models.length).toBeGreaterThan(0)
    // Well under vitest's default 5s test timeout — proves the hang is bounded, not
    // just "eventually settles because the test runner gave up."
    expect(Date.now() - start).toBeLessThan(3000)
  })

  // Finding 2: a failed/fallback fetch used to be cached for the process lifetime —
  // `STATIC_FALLBACK` lists only fable/sonnet-5/haiku-4-5, so a user pinned to
  // claude-opus-5 who starts offline would silently lose effort/1M/ultracode off the
  // wire for every session, forever, with no way back short of an app restart.
  it('retries after a short TTL rather than caching a failed fetch forever', async () => {
    vi.useFakeTimers()
    try {
      const q = fakeQuery(null, { throws: true })
      await fetchCatalog(q, { timeoutMs: 20 })
      expect(q).toHaveBeenCalledTimes(1)

      // Still inside the TTL window: the cached fallback is reused, no respawn.
      await fetchCatalog(q, { timeoutMs: 20 })
      expect(q).toHaveBeenCalledTimes(1)

      // Advance past the failure TTL — the app must recover on its own from here,
      // without a restart or a manual clearCatalogCache() call.
      await vi.advanceTimersByTimeAsync(60_000)

      await fetchCatalog(q, { timeoutMs: 20 })
      expect(q).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  // Finding 1: ask()'s try/catch does not cover its own finally block. A cleanup
  // (interrupt()) that throws synchronously — rather than returning a rejected promise —
  // replaces whatever the try block was about to return with a rejection, and
  // fetchCatalog had no `.catch` of its own, so that rejection propagated all the way up
  // through catalogFor -> the driver's handleReady -> events(), i.e. a blocked send. A
  // degraded menu is acceptable; a blocked send is not.
  it('resolves to the static fallback, never rejects, when cleanup throws synchronously', async () => {
    const models = await fetchCatalog(fakeQuery(fixture, { throwsInterruptSync: true }))
    // Must be the STATIC_FALLBACK list, not the fixture's models — the successful
    // supportedModels() result is unrecoverable once cleanup throws, so this can only
    // ever be the fallback, never the fixture's 'fable' alias.
    expect(models.some((m) => m.value === 'claude-sonnet-5')).toBe(true)
    expect(models.some((m) => m.value === 'fable')).toBe(false)
  })

  // Finding 1 (continued): a result reached via that new catch must be subject to the
  // same 60s failure TTL as every other fallback arm — not cached for the process
  // lifetime the way a genuine success is. Without this, cleanup throwing once would
  // brick the catalog for that cliPath forever.
  it('retries after the failure TTL even when the fallback was reached via a synchronous cleanup throw', async () => {
    vi.useFakeTimers()
    try {
      const q = fakeQuery(fixture, { throwsInterruptSync: true })
      await fetchCatalog(q)
      expect(q).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(60_000)

      await fetchCatalog(q)
      expect(q).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  // Finding 2: the success-vs-failure split rests entirely on the `result ===
  // STATIC_FALLBACK` identity check inside fetchCatalog's `.then`. Nothing previously
  // pinned "a successful fetch survives past the failure TTL" — the existing cache test
  // (above) never advances timers, so a future refactor that started expiring successful
  // catalogs too (e.g. hoisting the eviction out of the `if`, or returning a copy of the
  // fallback so the identity check stops matching) would pass every existing test.
  it('does not expire a successful fetch after the failure TTL elapses', async () => {
    vi.useFakeTimers()
    try {
      const q = fakeQuery(fixture)
      const models = await fetchCatalog(q)
      expect(models.some((m) => m.value === 'fable')).toBe(true)
      expect(q).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(60_000)

      await fetchCatalog(q)
      expect(q).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // Finding 3: the once-per-fetch warning was previously guaranteed only by reading the
  // code (it happens inside the `.then` attached to `raw`, which only runs once no
  // matter how many callers are awaiting the shared cached promise). Nothing asserted on
  // console.warn.
  it('warns exactly once for a degraded fetch shared by concurrent callers, and not again on a cache hit', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const q = fakeQuery(null, { throws: true })
      const [a, b] = await Promise.all([
        fetchCatalog(q, { timeoutMs: 20 }),
        fetchCatalog(q, { timeoutMs: 20 })
      ])
      expect(a.length).toBeGreaterThan(0)
      expect(b.length).toBeGreaterThan(0)
      expect(warnSpy).toHaveBeenCalledTimes(1)

      // A cache hit (still within the failure TTL) must not warn again — only an actual
      // fetch settling should log.
      await fetchCatalog(q, { timeoutMs: 20 })
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('catalogFor', () => {
  it('matches on the alias value', async () => {
    expect((await catalogFor(fakeQuery(fixture), undefined, 'fable'))?.displayName).toBe('Fable')
  })

  it('also matches on the resolved wire slug, so existing pinned sessions keep working', async () => {
    const info = await catalogFor(fakeQuery(fixture), undefined, 'claude-opus-5')
    expect(info?.supportsEffort).toBe(true)
  })

  it('returns null for a model the catalog does not know', async () => {
    expect(await catalogFor(fakeQuery(fixture), undefined, 'gpt-5.4')).toBeNull()
  })
})
