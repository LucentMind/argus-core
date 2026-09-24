import { describe, it, expect } from 'vitest'
import {
  DRIVERS,
  catalogModelRows,
  findModelRow,
  mergeBuiltinRows,
  pinSlugFor,
  resolveModelInfo
} from '../drivers'
import { descriptorsFor } from '../runOptions'
// The real captured CLI catalog — the whole point of this module is that it agrees with what
// the CLI actually emits, so asserting against a hand-written approximation would be circular.
import CLI_CATALOG from '../../main/services/agent/drivers/claude/__fixtures__/models-2-1-220.json'
import CLI_CATALOG_281 from '../../main/services/agent/drivers/claude/__fixtures__/models-2-1-281.json'
import CLI_CATALOG_281_ENTITLED from '../../main/services/agent/drivers/claude/__fixtures__/models-2-1-281-entitled.json'
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
  // that actually is.
  //
  // No " (1M)" suffix any more: this row no longer PINS 1M (see `pinSlugFor` below), so
  // naming it that restated a context window the Traits chip already reports, and restated it
  // wrongly for every session pinned to the bare slug. The suffix survives only where the row
  // really does pin the window — see 'keeps the (1M) name…' below.
  it('derives the name from resolvedModel rather than the CLI displayName', () => {
    const rows = catalogModelRows(CATALOG)
    expect(rows[0].name).toBe('Claude Opus 5')
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
      expect(rows[0].name).toBe('Claude Opus 5')
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
        'Claude Opus 5',
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

  // ── Context window is a run option, not part of the model's identity ──────────────────────
  //
  // The CLI's only Opus 5 alias is `opus[1m]`. Pinning a session at that suffix left
  // `apiModelId` unable to take it back off, so Context Window collapsed to a single inert
  // "1M" and every send went out at 1M — while the chip, matched back to the same row, read
  // "Claude Opus 5 (1M)" whatever the session was really pinned to. Live, that produced a
  // (1M) name sitting over a `High · 200k` traits chip.
  describe('pinSlugFor', () => {
    const rows = catalogModelRows(CLI_CATALOG as ModelOptionInfo[])
    const opus = rows.find((m) => m.slug === 'opus[1m]')!

    it('pins the bare wire slug for an alias that would otherwise force 1M', () => {
      expect(pinSlugFor(opus)).toBe('claude-opus-5')
    })

    // The point of pinning bare: 1M becomes reachable through the run option instead of being
    // frozen on. Asserted through `descriptorsFor`, the same function the composer builds its
    // Context Window control from, so this cannot pass while the control stays inert.
    it('leaves Context Window a real choice, which the alias slug did not', () => {
      const info = resolveModelInfo(CLI_CATALOG as ModelOptionInfo[], pinSlugFor(opus))!
      const cw = descriptorsFor(info, pinSlugFor(opus)).find((d) => d.id === 'contextWindow')
      expect(cw?.type === 'select' && cw.options.map((o) => o.value)).toEqual(['200k', '1m'])

      const asAlias = descriptorsFor(info, opus.slug).find((d) => d.id === 'contextWindow')
      expect(asAlias?.type === 'select' && asAlias.options.map((o) => o.value)).toEqual(['1m'])
    })

    it('leaves every other row alone', () => {
      expect(rows.filter((m) => m.slug !== 'opus[1m]').map(pinSlugFor)).toEqual([
        'fable',
        'sonnet',
        'haiku'
      ])
    })

    // Row IDENTITY must not move with the pin. Rewriting the row's own `slug` to the bare
    // form would have orphaned every session already pinned to `opus[1m]`: neither that string
    // nor its bare form `opus` matches `claude-opus-5`, so those chats would have fallen
    // through to the raw-slug fallback label. Both spellings must still find this row.
    it('keeps the row matchable by the alias a session may already be pinned to', () => {
      expect(findModelRow(rows, 'opus[1m]')).toBe(opus)
      expect(findModelRow(rows, 'claude-opus-5[1m]')).toBe(opus)
      expect(findModelRow(rows, 'claude-opus-5')).toBe(opus)
    })

    // A hand-added `[1m]` custom model is a deliberate choice, not an artefact of how the CLI
    // keys its catalog — `customModelRows` reports no `resolvedModel`, which is what keeps it
    // out of the rewrite.
    it('never rewrites a custom model the user typed the suffix into', () => {
      expect(pinSlugFor({ slug: 'claude-sonnet-5[1m]', name: 'x', isCustom: true })).toBe(
        'claude-sonnet-5[1m]'
      )
    })

    // Observed once on CLI 2.1.263 (2026-09-07, not reproduced on the next read): a row keyed
    // by a SUFFIXED wire slug whose `resolvedModel` is bare. The key is what goes on the wire,
    // so without the rewrite picking Fable 5 pinned 1M and lost the 200k cap. The row's own
    // identity is untouched: a session pinned to either spelling still finds it.
    it('pins bare for a catalog row keyed by a suffixed slug that resolves bare', () => {
      const [row] = catalogModelRows([
        {
          value: 'claude-fable-5[1m]',
          resolvedModel: 'claude-fable-5',
          displayName: 'Fable',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
        }
      ])
      expect(row.name).toBe('Claude Fable 5')
      expect(pinSlugFor(row)).toBe('claude-fable-5')
      expect(findModelRow([row], 'claude-fable-5')).toBe(row)
      expect(findModelRow([row], 'claude-fable-5[1m]')).toBe(row)
      const cw = descriptorsFor(resolveModelInfo([], pinSlugFor(row))!, pinSlugFor(row)).find(
        (d) => d.id === 'contextWindow'
      )
      expect(cw?.type === 'select' && cw.options.map((o) => o.value)).toEqual(['1m', 'cap-200k'])
    })

    // The rewrite is gated on shipping a static row for the bare model, because
    // CLAUDE_MODEL_SPECS is the only record of a slug having actually been run. An unknown
    // model keeps both the alias pin and — since it really does pin the window — the name
    // that says so.
    it('keeps the (1M) name and pin for a model we have no static row for', () => {
      const [row] = catalogModelRows([
        { value: 'zeta[1m]', resolvedModel: 'claude-zeta-9[1m]', displayName: 'Zeta' }
      ])
      expect(row.name).toBe('Claude Zeta 9 (1M)')
      expect(pinSlugFor(row)).toBe('zeta[1m]')
    })
  })
})

// 2.1.281 re-points `opus[1m]` and `default` at Opus 5.5 (spec 2026-09-24-opus-5-5-model-design).
// The naming, the bare pin and the merge must all land on the NEW model, and Opus 5, which no
// alias names any more, must survive as its own static row.
describe('against the 2.1.281 catalog (Opus 5.5)', () => {
  const rows = catalogModelRows(CLI_CATALOG_281 as ModelOptionInfo[])

  it('dedupes default into the opus[1m] row and names it Claude Opus 5.5', () => {
    const opus = rows.filter((m) => m.resolvedModel === 'claude-opus-5-5[1m]')
    expect(opus).toHaveLength(1)
    expect(opus[0].slug).toBe('opus[1m]')
    expect(opus[0].name).toBe('Claude Opus 5.5')
  })

  it('pins the bare Opus 5.5 slug for that row, never Opus 5', () => {
    const opus = rows.find((m) => m.slug === 'opus[1m]')!
    expect(pinSlugFor(opus)).toBe('claude-opus-5-5')
    expect(findModelRow(rows, 'claude-opus-5-5')).toBe(opus)
    expect(findModelRow(rows, 'claude-opus-5')).toBeNull()
  })

  it('merges into exactly one Opus 5.5 row and keeps Opus 5 via its static row', () => {
    const merged = mergeBuiltinRows(rows, DRIVERS['claude-agent-sdk'].models)
    expect(merged.filter((m) => m.name === 'Claude Opus 5.5')).toHaveLength(1)
    expect(merged.filter((m) => m.slug === 'claude-opus-5')).toHaveLength(1)
  })
})

// The same CLI once it has cached the org's model access: the catalog is the entitlement
// list, `default` is Sonnet 5 and `opus` is bare (EVIDENCE.md). Still one Opus 5.5, one Opus 5.
describe('against the 2.1.281 entitlement-list catalog', () => {
  const rows = catalogModelRows(CLI_CATALOG_281_ENTITLED as ModelOptionInfo[])
  const merged = mergeBuiltinRows(rows, DRIVERS['claude-agent-sdk'].models)

  it('names the opus row Claude Opus 5.5 and dedupes default into sonnet', () => {
    expect(rows.find((m) => m.slug === 'opus')?.name).toBe('Claude Opus 5.5')
    expect(rows.filter((m) => m.resolvedModel === 'claude-sonnet-5')).toHaveLength(1)
    expect(rows.some((m) => m.slug === 'default')).toBe(false)
  })

  it('resolves both Opus wire slugs to their own rows', () => {
    expect(findModelRow(rows, 'claude-opus-5-5')?.slug).toBe('opus')
    expect(findModelRow(rows, 'claude-opus-5')?.slug).toBe('claude-opus-5')
  })

  it('merges into exactly one row each for Opus 5.5 and Opus 5', () => {
    expect(merged.filter((m) => m.name === 'Claude Opus 5.5')).toHaveLength(1)
    expect(merged.filter((m) => m.name === 'Claude Opus 5')).toHaveLength(1)
  })

  // Neither `opus` nor `claude-opus-5-5` carries a `[1m]`, so `pinSlugFor` has nothing to strip.
  it('pins the opus alias itself for the bare opus row (no 1M to strip)', () => {
    expect(pinSlugFor(rows.find((m) => m.slug === 'opus')!)).toBe('opus')
  })
})
