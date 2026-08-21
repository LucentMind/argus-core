import { describe, it, expect } from 'vitest'
import { blockedOf, describeBlocked, surfacedBlocked, SURFACED_BLOCK_KINDS } from '../currency'
import type { BlockedReason, Candidate } from '../currency'
import { settingsSchema } from '../settings'

const clean: Candidate = {
  domain: 'pack',
  key: 'code-graph',
  label: 'Code Graph',
  from: '1.0.0',
  to: '1.1.0',
  verdict: 'clean'
}
const blocked: Candidate = {
  domain: 'hive-reference',
  key: 'reference/style.md',
  label: 'style.md',
  from: 'abc123',
  to: 'def456',
  verdict: 'blocked',
  reason: { kind: 'local-edits' }
}

describe('blockedOf', () => {
  it('keeps only blocked candidates', () => {
    expect(blockedOf([clean, blocked])).toEqual([blocked])
  })

  it('is empty when everything is clean', () => {
    expect(blockedOf([clean])).toEqual([])
  })
})

describe('updates.auto', () => {
  it('defaults to true', () => {
    expect(settingsSchema.parse({}).updates.auto).toBe(true)
  })

  it('round-trips false', () => {
    expect(settingsSchema.parse({ updates: { auto: false } }).updates.auto).toBe(false)
  })

  it('still defaults the whole section from an empty object', () => {
    expect(settingsSchema.parse({ updates: {} }).updates).toEqual({ channel: 'stable', auto: true })
  })
})

const cand = (reason: BlockedReason): Candidate => ({
  domain: 'pack',
  key: 'k',
  label: 'k',
  from: '1',
  to: '2',
  verdict: 'blocked',
  reason
})

describe('describeBlocked', () => {
  it('words every reason kind', () => {
    expect(describeBlocked({ kind: 'local-edits' })).toBe('You have edited this locally.')
    expect(describeBlocked({ kind: 'tier-change', from: 'mine', to: 'hivemind' })).toBe(
      'This update would change its trust tier from mine to hivemind.'
    )
    expect(describeBlocked({ kind: 'new-dependency' })).toBe('This update needs a new dependency.')
    expect(describeBlocked({ kind: 'auth' })).toBe('Sign in to the GitHub CLI to continue.')
    expect(describeBlocked({ kind: 'missing' })).toBe('Install the GitHub CLI to continue.')
    expect(describeBlocked({ kind: 'notfound' })).toBe(
      "The repository can't be found — check that it still exists and is visible to your account."
    )
    expect(describeBlocked({ kind: 'downgrade' })).toBe(
      'Installing it would move this install back a version.'
    )
    expect(describeBlocked({ kind: 'origin-pin' })).toBe(
      'It no longer comes from the origin it was installed from — download it from your vendor and use Install from file.'
    )
    expect(describeBlocked({ kind: 'unsupported' })).toBe(
      'Updates are only available in a packaged build.'
    )
  })

  // Finding 4 (whole-branch review): `referenceTier` returns '' for a file with no `trust_tier`
  // frontmatter, so `localDivergence` legitimately produces `{ from: '', to: 'hivemind' }` for an
  // unstamped local reference the hive offers. The pre-existing update-confirm panel already
  // handles exactly this (`HivemindSettings.tsx`'s `{tierChange.from || 'none'}`, backed by its own
  // regression test) — this sentence has to match that precedent rather than reopen the blank gap
  // it was written to close.
  it('renders "none" rather than a blank gap when a tier is unreadable', () => {
    expect(describeBlocked({ kind: 'tier-change', from: '', to: 'hivemind' })).toBe(
      'This update would change its trust tier from none to hivemind.'
    )
    // The destination side of the same sentence, for completeness — nothing in this codebase
    // currently produces to: '', but the wording has to stay honest if one ever does.
    expect(describeBlocked({ kind: 'tier-change', from: 'hivemind', to: '' })).toBe(
      'This update would change its trust tier from hivemind to none.'
    )
  })
})

describe('surfacedBlocked', () => {
  it('drops unsupported, which is not a decision anyone can make', () => {
    expect(surfacedBlocked([cand({ kind: 'unsupported' })])).toEqual([])
  })

  it('keeps every other kind', () => {
    const kinds: BlockedReason[] = [
      { kind: 'local-edits' },
      { kind: 'tier-change', from: 'a', to: 'b' },
      { kind: 'new-dependency' },
      { kind: 'auth' },
      { kind: 'missing' },
      { kind: 'notfound' },
      { kind: 'downgrade' },
      { kind: 'origin-pin' }
    ]
    expect(surfacedBlocked(kinds.map(cand))).toHaveLength(8)
  })

  it('ignores clean candidates entirely', () => {
    const clean: Candidate = {
      domain: 'pack',
      key: 'c',
      label: 'c',
      from: '1',
      to: '2',
      verdict: 'clean'
    }
    expect(surfacedBlocked([clean])).toEqual([])
  })

  it('exposes the surfaced set so no caller re-derives it', () => {
    expect(SURFACED_BLOCK_KINDS.has('unsupported')).toBe(false)
    expect(SURFACED_BLOCK_KINDS.has('local-edits')).toBe(true)
  })

  // Pins the whole-branch-review fix: 'auth', 'missing' and 'notfound' are three DIFFERENT gh
  // failures, each with something a person can actually act on — unlike a plain transport
  // failure, which never reaches `BlockedReason` at all (see packsAdapter.test.ts).
  it('surfaces both new gh-failure kinds — a person can act on either', () => {
    expect(SURFACED_BLOCK_KINDS.has('missing')).toBe(true)
    expect(SURFACED_BLOCK_KINDS.has('notfound')).toBe(true)
  })
})
