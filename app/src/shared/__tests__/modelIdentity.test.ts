import { describe, it, expect } from 'vitest'
import { canonicalSlug, findModelEntry, modelMatches, type ModelIdentity } from '../modelIdentity'
// The real captured CLI catalog — the whole point of this module is that it agrees with what
// the CLI actually emits, so asserting against a hand-written approximation would be circular.
import CLI_CATALOG from '../../main/services/agent/drivers/claude/__fixtures__/models-2-1-220.json'

const rows = CLI_CATALOG as ModelIdentity[]
const self = (r: ModelIdentity): ModelIdentity => r

describe('findModelEntry against the real CLI catalog', () => {
  // The defect: not one `value` in the captured catalog is a `claude-*` string, while every
  // session is pinned to one.
  it('has no claude-* alias to match against, which is why value equality never hit', () => {
    expect(rows.some((r) => r.value.startsWith('claude-'))).toBe(false)
  })

  it('resolves a session pinned to a static wire slug via resolvedModel', () => {
    expect(findModelEntry(rows, 'claude-fable-5', self)?.value).toBe('fable')
    expect(findModelEntry(rows, 'claude-sonnet-5', self)?.value).toBe('sonnet')
  })

  it('matches the alias directly when that is what the session stored', () => {
    expect(findModelEntry(rows, 'opus[1m]', self)?.value).toBe('opus[1m]')
    expect(findModelEntry(rows, 'haiku', self)?.value).toBe('haiku')
  })

  it('strips a trailing [1m] on either side', () => {
    // pinned bare, row suffixed
    expect(findModelEntry(rows, 'opus', self)?.value).toBe('opus[1m]')
    // pinned suffixed, resolvedModel suffixed
    expect(findModelEntry(rows, 'claude-opus-5[1m]', self)?.value).toBe('default')
    // pinned bare, resolvedModel suffixed
    expect(findModelEntry(rows, 'claude-opus-5', self)?.value).toBe('default')
  })

  it('prefers a value match over a resolvedModel match', () => {
    // `default` and `opus[1m]` share resolvedModel claude-opus-5[1m]; asking for the alias
    // must not hand back the other row just because it appears first.
    expect(findModelEntry(rows, 'opus[1m]', self)?.value).toBe('opus[1m]')
  })

  it('returns null rather than guessing for a model the CLI does not offer', () => {
    expect(findModelEntry(rows, 'claude-opus-4-8', self)).toBeNull()
    expect(findModelEntry(rows, 'gpt-5.4', self)).toBeNull()
    expect(findModelEntry(rows, null, self)).toBeNull()
    expect(findModelEntry(rows, '', self)).toBeNull()
  })

  // UPDATED for Finding 1: this used to assert `claude-haiku-4-5` did NOT match the haiku row,
  // which was the bug — the stored Settings preference for Haiku is the undated static slug
  // `claude-haiku-4-5`, but this fixture's haiku row only reports a DATED `resolvedModel`
  // (`claude-haiku-4-5-20251001`), so hiding/favouriting/reordering Haiku in Settings silently
  // failed to affect the composer picker once the live catalog loaded. The fix is a narrow
  // date-suffix rule (`resolvesToId`): a stored id matches a `resolvedModel` that is exactly
  // that id plus `-YYYYMMDD`. It is still NOT a general prefix rule — see the next test.
  it('resolves a session pinned to the undated static slug via a dated resolvedModel', () => {
    expect(findModelEntry(rows, 'claude-haiku-4-5', self)?.value).toBe('haiku')
  })

  // A general prefix rule would make claude-opus-4 match claude-opus-4-8. The date-suffix rule
  // does not: claude-opus-4-8 is not a valid `-YYYYMMDD` suffix, and no row resolves to it
  // anyway. Documented here so it reads as a decision, not an oversight.
  it('still does not treat an arbitrary suffix as a prefix match', () => {
    expect(findModelEntry(rows, 'claude-opus-4', self)).toBeNull()
    expect(findModelEntry(rows, 'claude-opus-4-8', self)).toBeNull()
  })
})

describe('modelMatches', () => {
  it('is true for every form findModelEntry accepts', () => {
    const fable: ModelIdentity = { value: 'fable', resolvedModel: 'claude-fable-5' }
    expect(modelMatches(fable, 'fable')).toBe(true)
    expect(modelMatches(fable, 'claude-fable-5')).toBe(true)
    expect(modelMatches(fable, 'claude-fable-5[1m]')).toBe(true)
    expect(modelMatches(fable, 'sonnet')).toBe(false)
  })

  it('works on a row with no resolvedModel, i.e. the static/offline shape', () => {
    const staticRow: ModelIdentity = { value: 'claude-sonnet-5' }
    expect(modelMatches(staticRow, 'claude-sonnet-5')).toBe(true)
    expect(modelMatches(staticRow, 'claude-sonnet-5[1m]')).toBe(true)
    expect(modelMatches(staticRow, 'sonnet')).toBe(false)
  })

  // Finding 1, pinned directly (not just via the fixture): a stored preference for the
  // undated static slug must match a row whose resolvedModel carries the CLI's date suffix —
  // that gap is exactly why hiding Haiku in Settings did not hide it in the composer.
  it('matches a stored undated slug against a resolvedModel with a date suffix', () => {
    const haiku: ModelIdentity = { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' }
    expect(modelMatches(haiku, 'claude-haiku-4-5')).toBe(true)
  })

  // The collision a naive prefix rule would cause, and the reason this is a dedicated
  // date-suffix check rather than a `startsWith`: claude-opus-4 must NOT match a row for the
  // unrelated model claude-opus-4-8, whether that id appears as `value` or `resolvedModel`.
  it('does not match claude-opus-4 against claude-opus-4-8 (not a date suffix)', () => {
    expect(modelMatches({ value: 'claude-opus-4-8' }, 'claude-opus-4')).toBe(false)
    expect(
      modelMatches({ value: 'opus-4-8', resolvedModel: 'claude-opus-4-8' }, 'claude-opus-4')
    ).toBe(false)
  })
})

// ── canonicalSlug: the identity a stored PREFERENCE must use ────────────────────────────────
//
// A row's `value` is catalog-version-dependent (`opus[1m]` today, whatever the CLI recommends
// tomorrow) and means nothing without the catalog that produced it. Storing a preference under
// it is what made a favourited Opus 5 invisible to `defaultModelRef`, which sorts the STATIC
// list. `canonicalSlug` is the stable counterpart: the wire slug, stripped of the two
// version-dependent suffixes the CLI adds.
describe('canonicalSlug', () => {
  it('resolves a CLI alias to its wire slug', () => {
    expect(canonicalSlug({ value: 'fable', resolvedModel: 'claude-fable-5' })).toBe(
      'claude-fable-5'
    )
  })

  it('strips the [1m] suffix — the bug: opus[1m] must store as claude-opus-5', () => {
    expect(canonicalSlug({ value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]' })).toBe(
      'claude-opus-5'
    )
  })

  // A dated slug is as version-dependent as an alias: stored verbatim it stops matching the
  // moment the CLI ships a new Haiku build, which is the same defect one layer down.
  it('strips a -YYYYMMDD date segment', () => {
    expect(canonicalSlug({ value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' })).toBe(
      'claude-haiku-4-5'
    )
  })

  it('strips both suffixes together', () => {
    expect(canonicalSlug({ value: 'x', resolvedModel: 'claude-haiku-4-5-20251001[1m]' })).toBe(
      'claude-haiku-4-5'
    )
  })

  // The static/offline shape and custom models: `value` already IS the wire slug, and an
  // explicit `claude-sonnet-5[1m]` custom model is a model in its own right (see
  // `resolvesToId`'s docblock), so nothing is stripped when there is no resolvedModel.
  it('keeps a row with no resolvedModel exactly as it is', () => {
    expect(canonicalSlug({ value: 'claude-opus-4-8' })).toBe('claude-opus-4-8')
    expect(canonicalSlug({ value: 'claude-sonnet-5[1m]' })).toBe('claude-sonnet-5[1m]')
  })

  // The round trip that makes storage safe: whatever canonicalSlug emits must still match the
  // row it came from, or hiding/favouriting would silently stop applying to that row.
  it('every real catalog row still matches its own canonical slug', () => {
    for (const r of rows) expect(modelMatches(r, canonicalSlug(r))).toBe(true)
  })
})
