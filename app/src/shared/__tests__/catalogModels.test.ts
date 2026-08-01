import { describe, it, expect } from 'vitest'
import { mergeCatalogModels } from '../drivers'

const STATIC = [
  { slug: 'claude-fable-5', name: 'Claude Fable 5' },
  { slug: 'claude-opus-4-7', name: 'Claude Opus 4.7' }
]
const CATALOG = [
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)' },
  { value: 'fable', resolvedModel: 'claude-fable-5', displayName: 'Fable' }
]

describe('mergeCatalogModels', () => {
  it('uses the runtime catalog when it has entries', () => {
    const merged = mergeCatalogModels(STATIC, CATALOG)
    expect(merged.map((m) => m.slug)).toEqual(['opus[1m]', 'fable'])
    expect(merged[0].name).toBe('Opus (1M context)')
  })

  // This is the bug that motivated the whole runtime approach.
  it('surfaces Opus 5, which the static list does not contain', () => {
    const merged = mergeCatalogModels(STATIC, CATALOG)
    expect(merged.some((m) => m.slug === 'opus[1m]')).toBe(true)
  })

  it('drops models the CLI no longer offers', () => {
    const merged = mergeCatalogModels(STATIC, CATALOG)
    expect(merged.some((m) => m.slug === 'claude-opus-4-7')).toBe(false)
  })

  it('falls back to the static list when the catalog is empty', () => {
    expect(mergeCatalogModels(STATIC, [])).toEqual(STATIC)
  })
})
