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
