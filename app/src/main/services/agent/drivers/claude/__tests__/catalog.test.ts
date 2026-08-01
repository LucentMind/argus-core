import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fetchCatalog, catalogFor, clearCatalogCache } from '../catalog'
import type { CreateQueryFn } from '../index'
import fixture from '../__fixtures__/models-2-1-220.json'

function fakeQuery(
  models: unknown,
  opts: { throws?: boolean; hang?: boolean; hangInterrupt?: boolean } = {}
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
