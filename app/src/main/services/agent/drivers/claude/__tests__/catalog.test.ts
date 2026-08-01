import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fetchCatalog, catalogFor, clearCatalogCache } from '../catalog'
import fixture from '../__fixtures__/models-2-1-220.json'

function fakeQuery(models: unknown, opts: { throws?: boolean; hang?: boolean } = {}): never {
  return vi.fn(() => ({
    supportedModels: async () => {
      if (opts.throws) throw new Error('CLI not found')
      if (opts.hang) await new Promise(() => undefined)
      return models
    },
    interrupt: async () => undefined,
    // Never iterated — ask() returns before consuming this once supportedModels is found.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    [Symbol.asyncIterator]: async function* () {}
  })) as never
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
