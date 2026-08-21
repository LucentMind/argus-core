import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CurrencyService } from '../service'
import { CurrencyAnchorStore } from '../anchors'
import type { CurrencyAdapter } from '../adapter'
import type { Candidate } from '../../../../../shared/currency'

const SIX_H = 21_600_000

function memStore(): { load: () => { data: unknown; error: null }; write: (o: unknown) => void } {
  let data: unknown = {}
  return {
    load: () => ({ data, error: null }),
    write: (o: unknown) => {
      data = JSON.parse(JSON.stringify(o))
    }
  }
}

const authBlocked: Candidate = {
  domain: 'pack',
  key: 'code-graph',
  label: 'Code Graph',
  from: '1.0.0',
  to: '1.0.0',
  verdict: 'blocked',
  reason: { kind: 'auth' }
}

function build(
  adapter: CurrencyAdapter,
  over: { auto?: () => boolean; now?: () => number } = {}
): CurrencyService {
  return new CurrencyService({
    adapters: [adapter],
    anchors: new CurrencyAnchorStore(memStore()),
    autoEnabled: over.auto ?? (() => true),
    isQuiet: () => true,
    now: over.now ?? (() => 0),
    tickMs: 1_000,
    intervalMs: SIX_H
  })
}

describe('CurrencyService policy', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('surveyNow works even with auto mode off', async () => {
    const adapter: CurrencyAdapter = {
      id: 'packs',
      survey: vi.fn(async () => []),
      apply: vi.fn(async () => ({ ok: true as const }))
    }
    const svc = build(adapter, { auto: () => false })
    await svc.surveyNow('packs')
    expect(adapter.survey).toHaveBeenCalledTimes(1)
  })

  it('surveyNow is rate-limited to the interval', async () => {
    let t = 0
    const adapter: CurrencyAdapter = {
      id: 'packs',
      survey: vi.fn(async () => []),
      apply: vi.fn(async () => ({ ok: true as const }))
    }
    const svc = build(adapter, { now: () => t })
    await svc.surveyNow('packs')
    t = SIX_H - 1
    await svc.surveyNow('packs')
    expect(adapter.survey).toHaveBeenCalledTimes(1)
    t = SIX_H + 1
    await svc.surveyNow('packs')
    expect(adapter.survey).toHaveBeenCalledTimes(2)
  })

  // Finding 3: after a restart the in-memory per-domain status map is empty and the adapter is
  // not due, so a plain `surveyNow` refuses to run for up to 6h — but the manual "Check for
  // updates" button has to work RIGHT NOW regardless of when the last survey happened, since that
  // is the whole point of a manual check.
  it('force bypasses the rate limit', async () => {
    let t = 0
    const adapter: CurrencyAdapter = {
      id: 'packs',
      survey: vi.fn(async () => []),
      apply: vi.fn(async () => ({ ok: true as const }))
    }
    const svc = build(adapter, { now: () => t })
    await svc.surveyNow('packs')
    expect(adapter.survey).toHaveBeenCalledTimes(1)
    // Still well inside the interval — a plain call would be refused (see the test above).
    t = SIX_H - 1
    await svc.surveyNow('packs', true)
    expect(adapter.survey).toHaveBeenCalledTimes(2)
  })

  it('a forced survey still records the anchor, so the NEXT plain survey is rate-limited from it', async () => {
    let t = 0
    const adapter: CurrencyAdapter = {
      id: 'packs',
      survey: vi.fn(async () => []),
      apply: vi.fn(async () => ({ ok: true as const }))
    }
    const svc = build(adapter, { now: () => t })
    await svc.surveyNow('packs', true)
    expect(adapter.survey).toHaveBeenCalledTimes(1)
    t = SIX_H - 1
    await svc.surveyNow('packs') // plain — must still respect the anchor the forced call left
    expect(adapter.survey).toHaveBeenCalledTimes(1)
  })

  it('surveyNow with auto off does not apply anything', async () => {
    const adapter: CurrencyAdapter = {
      id: 'packs',
      survey: vi.fn(async () => [
        {
          domain: 'pack' as const,
          key: 'a',
          label: 'a',
          from: '1',
          to: '2',
          verdict: 'clean' as const
        }
      ]),
      apply: vi.fn(async () => ({ ok: true as const }))
    }
    const svc = build(adapter, { auto: () => false })
    await svc.surveyNow('packs')
    expect(adapter.apply).not.toHaveBeenCalled()
  })

  it('hides an auth block on its first occurrence and shows it on the second', async () => {
    let t = 0
    const adapter: CurrencyAdapter = {
      id: 'packs',
      survey: vi.fn(async () => [authBlocked]),
      apply: vi.fn(async () => ({ ok: true as const }))
    }
    const svc = build(adapter, { now: () => t })
    await svc.surveyNow('packs')
    expect(svc.payload().blocked).toEqual([])
    t = SIX_H + 1
    await svc.surveyNow('packs')
    expect(svc.payload().blocked).toEqual([authBlocked])
  })

  it('forgets the auth strike once a survey comes back clean', async () => {
    let t = 0
    let broken = true
    const adapter: CurrencyAdapter = {
      id: 'packs',
      survey: vi.fn(async () => (broken ? [authBlocked] : [])),
      apply: vi.fn(async () => ({ ok: true as const }))
    }
    const svc = build(adapter, { now: () => t })
    await svc.surveyNow('packs')
    broken = false
    t = SIX_H + 1
    await svc.surveyNow('packs')
    broken = true
    t = SIX_H * 2 + 2
    await svc.surveyNow('packs')
    expect(svc.payload().blocked).toEqual([])
  })

  // Important 4 (second whole-branch review): before the gh error split, all four `GhError` kinds
  // arrived collapsed into `{ kind: 'auth' }` and were covered by the two-strike grace. The split
  // narrowed the grace to literally `'auth'`, so `notfound` — a `gh` HTTP 404, which GitHub answers
  // identically for "no such repo" and "a transient permission blip / SSO re-authorization" —
  // regressed to badging on its first sighting, exactly the flaky-network shape the grace exists
  // to withhold.
  it('hides a notfound block on its first occurrence and shows it on the second, same grace as auth', async () => {
    let t = 0
    const notfoundBlocked: Candidate = { ...authBlocked, reason: { kind: 'notfound' } }
    const adapter: CurrencyAdapter = {
      id: 'packs',
      survey: vi.fn(async () => [notfoundBlocked]),
      apply: vi.fn(async () => ({ ok: true as const }))
    }
    const svc = build(adapter, { now: () => t })
    await svc.surveyNow('packs')
    expect(svc.payload().blocked).toEqual([])
    t = SIX_H + 1
    await svc.surveyNow('packs')
    expect(svc.payload().blocked).toEqual([notfoundBlocked])
  })

  // `missing` (gh not installed / not on PATH) stays immediate on purpose — deterministic, not a
  // flaky-network shape to wait out — so it must NOT be swept into the grace by whatever mechanism
  // covers `auth`/`notfound`.
  it('shows a missing block immediately — needs only one occurrence', async () => {
    const missingBlocked: Candidate = { ...authBlocked, reason: { kind: 'missing' } }
    const adapter: CurrencyAdapter = {
      id: 'packs',
      survey: vi.fn(async () => [missingBlocked]),
      apply: vi.fn(async () => ({ ok: true as const }))
    }
    const svc = build(adapter)
    await svc.surveyNow('packs')
    expect(svc.payload().blocked).toEqual([missingBlocked])
  })

  it('shows every non-auth block on its first occurrence', async () => {
    const localEdits: Candidate = {
      domain: 'hive-reference',
      key: 'reference/style.md',
      label: 'style.md',
      from: 'a',
      to: 'b',
      verdict: 'blocked',
      reason: { kind: 'local-edits' }
    }
    const adapter: CurrencyAdapter = {
      id: 'hive',
      survey: vi.fn(async () => [localEdits]),
      apply: vi.fn(async () => ({ ok: true as const }))
    }
    const svc = build(adapter)
    await svc.surveyNow('hive')
    expect(svc.payload().blocked).toEqual([localEdits])
  })
})
