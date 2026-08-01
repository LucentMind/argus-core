import { describe, it, expect } from 'vitest'
import { catalogModelRows } from '../drivers'

const CATALOG = [
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)' },
  { value: 'fable', resolvedModel: 'claude-fable-5', displayName: 'Fable' },
  { value: 'auto', displayName: 'Auto' }
]

describe('catalogModelRows', () => {
  it('converts the runtime catalog into picker rows', () => {
    const rows = catalogModelRows(CATALOG)
    expect(rows.map((m) => m.slug)).toEqual(['opus[1m]', 'fable', 'auto'])
    expect(rows[0].name).toBe('Opus (1M context)')
  })

  // This is the bug that motivated the whole runtime approach.
  it('surfaces Opus 5, which the static list does not contain', () => {
    expect(catalogModelRows(CATALOG).some((m) => m.slug === 'opus[1m]')).toBe(true)
  })

  // C1: without this the row cannot be matched against a session pinned by wire slug, which
  // is how every chat's chip came to read "Default (recommended)".
  it('carries resolvedModel through, and omits the key when the CLI reports none', () => {
    const rows = catalogModelRows(CATALOG)
    expect(rows[0].resolvedModel).toBe('claude-opus-5[1m]')
    expect(rows[2]).not.toHaveProperty('resolvedModel')
  })

  it('produces nothing from an empty catalog, leaving substitution to the caller', () => {
    expect(catalogModelRows([])).toEqual([])
  })
})
