import { describe, it, expect } from 'vitest'
import { catalogModelRows } from '../drivers'
// The real captured CLI catalog — the whole point of this module is that it agrees with what
// the CLI actually emits, so asserting against a hand-written approximation would be circular.
import CLI_CATALOG from '../../main/services/agent/drivers/claude/__fixtures__/models-2-1-220.json'
import type { ModelOptionInfo } from '../runOptions'

const CATALOG = [
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)' },
  { value: 'fable', resolvedModel: 'claude-fable-5', displayName: 'Fable' },
  { value: 'auto', displayName: 'Auto' }
]

describe('catalogModelRows', () => {
  it('converts the runtime catalog into picker rows', () => {
    const rows = catalogModelRows(CATALOG)
    expect(rows.map((m) => m.slug)).toEqual(['opus[1m]', 'fable', 'auto'])
  })

  // Change 2a: the row's name comes from `resolvedModel` (the real wire slug), not the CLI's
  // own terse `displayName` — "Opus (1M context)" told the user nothing about which model
  // that actually is. `claude-opus-5` isn't in the static CLAUDE_MODELS table, so this falls
  // through to the slug-prettifier and picks up the `[1m]` suffix as a trailing " (1M)".
  it('derives the name from resolvedModel rather than the CLI displayName', () => {
    const rows = catalogModelRows(CATALOG)
    expect(rows[0].name).toBe('Claude Opus 5 (1M)')
  })

  // `claude-fable-5` DOES appear in the static CLAUDE_MODELS table, so the derived name is
  // that table's own name rather than a prettified slug — the two must agree.
  it('prefers a static CLAUDE_MODELS name over prettifying, when the slug is a known one', () => {
    const rows = catalogModelRows(CATALOG)
    expect(rows[1].name).toBe('Claude Fable 5')
  })

  // A row reporting no resolvedModel at all (never observed live, but the type allows it) has
  // nothing to derive a better name from, so it keeps the CLI's own displayName verbatim.
  it('falls back to the raw displayName when the CLI reports no resolvedModel', () => {
    const rows = catalogModelRows(CATALOG)
    expect(rows[2].name).toBe('Auto')
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

  // ── Change 2b: dedupe rows that resolve to the identical model ───────────────────────────
  describe('dedup', () => {
    it('collapses two rows sharing a resolvedModel, keeping the specific alias over `default`', () => {
      const rows = catalogModelRows([
        {
          value: 'default',
          resolvedModel: 'claude-opus-5[1m]',
          displayName: 'Default (recommended)'
        },
        { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)' }
      ])
      expect(rows).toHaveLength(1)
      expect(rows[0].slug).toBe('opus[1m]')
      expect(rows[0].name).toBe('Claude Opus 5 (1M)')
    })

    it('keeps the specific alias regardless of which order the two rows arrive in', () => {
      const rows = catalogModelRows([
        { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)' },
        {
          value: 'default',
          resolvedModel: 'claude-opus-5[1m]',
          displayName: 'Default (recommended)'
        }
      ])
      expect(rows).toHaveLength(1)
      expect(rows[0].slug).toBe('opus[1m]')
    })

    it('leaves rows with distinct resolvedModel values untouched', () => {
      const rows = catalogModelRows(CATALOG)
      expect(rows).toHaveLength(3)
    })

    it('never dedupes a row with no resolvedModel — there is no shared identity to collapse', () => {
      const rows = catalogModelRows([
        { value: 'auto', displayName: 'Auto' },
        { value: 'auto2', displayName: 'Auto 2' }
      ])
      expect(rows).toHaveLength(2)
    })
  })

  // ── Change 2, against the real fixture: naming + dedupe end-to-end ────────────────────────
  describe('against the real captured CLI catalog', () => {
    const rows = catalogModelRows(CLI_CATALOG as ModelOptionInfo[])

    it('deduplicates `default` and `opus[1m]` (both resolve to claude-opus-5[1m]) down to 4 rows', () => {
      expect(rows).toHaveLength(4)
      expect(rows.map((m) => m.slug)).toEqual(['opus[1m]', 'fable', 'sonnet', 'haiku'])
    })

    it('names every row recognisably', () => {
      expect(rows.map((m) => m.name)).toEqual([
        'Claude Opus 5 (1M)',
        'Claude Fable 5',
        'Claude Sonnet 5',
        'Claude Haiku 4.5'
      ])
    })

    // The haiku row's resolvedModel carries the CLI's `-YYYYMMDD` date suffix
    // (`claude-haiku-4-5-20251001`) — this is the one row in the fixture that exercises the
    // date-suffix branch of the naming lookup, not just an exact CLAUDE_MODELS match.
    it('drops the date suffix when naming a dated resolvedModel', () => {
      expect(rows.find((m) => m.slug === 'haiku')?.name).toBe('Claude Haiku 4.5')
    })
  })
})
