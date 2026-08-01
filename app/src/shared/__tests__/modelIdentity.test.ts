import { describe, it, expect } from 'vitest'
import { findModelEntry, modelMatches, type ModelIdentity } from '../modelIdentity'
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

  // A prefix rule would make claude-opus-4 match claude-opus-4-8, so the dated haiku slug is
  // deliberately NOT matched by the undated one. Documented here so it reads as a decision.
  it('does not treat a dated resolvedModel as a prefix match', () => {
    expect(findModelEntry(rows, 'claude-haiku-4-5', self)).toBeNull()
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
})
