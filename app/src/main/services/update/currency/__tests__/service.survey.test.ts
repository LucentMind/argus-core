import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CurrencyService } from '../service'
import { CurrencyAnchorStore } from '../anchors'
import type { CurrencyAdapter } from '../adapter'
import type { Candidate } from '../../../../../shared/currency'

const SIX_H = 21_600_000

function memStore(initial: unknown = {}): {
  load: () => { data: unknown; error: null }
  write: (o: unknown) => void
} {
  let data: unknown = initial
  return {
    load: () => ({ data, error: null }),
    write: (o: unknown) => {
      data = JSON.parse(JSON.stringify(o))
    }
  }
}

function fakeAdapter(id: 'core' | 'packs' | 'hive', candidates: Candidate[] = []): CurrencyAdapter {
  return {
    id,
    survey: vi.fn(async () => candidates),
    apply: vi.fn(async () => ({ ok: true as const }))
  }
}

function build(
  adapters: CurrencyAdapter[],
  over: {
    now?: () => number
    quiet?: boolean
    auto?: boolean
    store?: ReturnType<typeof memStore>
  } = {}
): { svc: CurrencyService; store: ReturnType<typeof memStore> } {
  const store = over.store ?? memStore()
  const svc = new CurrencyService({
    adapters,
    anchors: new CurrencyAnchorStore(store),
    autoEnabled: () => over.auto ?? true,
    isQuiet: () => over.quiet ?? true,
    now: over.now ?? (() => 0),
    tickMs: 1_000,
    intervalMs: SIX_H
  })
  return { svc, store }
}

describe('CurrencyService surveying', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('surveys every adapter on the first tick', async () => {
    const a = fakeAdapter('packs')
    const b = fakeAdapter('hive')
    const { svc } = build([a, b])
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(a.survey).toHaveBeenCalledTimes(1)
    expect(b.survey).toHaveBeenCalledTimes(1)
    svc.stop()
  })

  it('does not survey again before the interval elapses', async () => {
    let t = 0
    const a = fakeAdapter('packs')
    const { svc } = build([a], { now: () => t })
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    t = SIX_H - 1
    await vi.advanceTimersByTimeAsync(2_000)
    expect(a.survey).toHaveBeenCalledTimes(1)
    svc.stop()
  })

  it('surveys again once the interval has elapsed', async () => {
    let t = 0
    const a = fakeAdapter('packs')
    const { svc } = build([a], { now: () => t })
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    t = SIX_H + 1
    await vi.advanceTimersByTimeAsync(2_000)
    expect(a.survey).toHaveBeenCalledTimes(2)
    svc.stop()
  })

  it('surveys ONCE after a long shutdown, not once per missed interval', async () => {
    const store = memStore({ packs: { lastSurveyAt: 0, consecutiveFailures: 0 } })
    const a = fakeAdapter('packs')
    // Three days later.
    const { svc } = build([a], { now: () => SIX_H * 12, store })
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(a.survey).toHaveBeenCalledTimes(1)
    svc.stop()
  })

  it('persists the anchor after a successful survey', async () => {
    const a = fakeAdapter('packs')
    const { svc, store } = build([a], { now: () => 4_242 })
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    expect((store.load().data as Record<string, unknown>).packs).toEqual({
      lastSurveyAt: 4_242,
      consecutiveFailures: 0
    })
    svc.stop()
  })

  it('never surveys while auto mode is off', async () => {
    const a = fakeAdapter('packs')
    const { svc } = build([a], { auto: false })
    svc.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(a.survey).not.toHaveBeenCalled()
    svc.stop()
  })

  it('publishes the survey time and notifies subscribers', async () => {
    const a = fakeAdapter('packs')
    const { svc } = build([a], { now: () => 4_242 })
    const seen: number[] = []
    svc.subscribe(() => seen.push(1))
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.payload().lastSurveyAt).toBe(new Date(4_242).toISOString())
    expect(seen.length).toBeGreaterThan(0)
    svc.stop()
  })

  it('stop() ends the polling', async () => {
    let t = 0
    const a = fakeAdapter('packs')
    const { svc } = build([a], { now: () => t })
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    svc.stop()
    t = SIX_H * 5
    await vi.advanceTimersByTimeAsync(10_000)
    expect(a.survey).toHaveBeenCalledTimes(1)
  })
})

function throwingAdapter(id: 'core' | 'packs' | 'hive'): CurrencyAdapter {
  return {
    id,
    survey: vi.fn(async () => {
      throw new Error('transport failure')
    }),
    apply: vi.fn(async () => ({ ok: true as const }))
  }
}

describe('CurrencyService surveying — a rejecting adapter.survey()', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('produces no blocked entries and no error field — the failure is silent', async () => {
    const a = throwingAdapter('packs')
    const { svc } = build([a])
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    const p = svc.payload()
    expect(p.blocked).toEqual([])
    expect(p).not.toHaveProperty('error')
    svc.stop()
  })

  it('resets busy to false (the finally runs even on rejection)', async () => {
    const a = throwingAdapter('packs')
    const { svc } = build([a])
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.payload().busy).toBe(false)
    svc.stop()
  })

  it('records the failure to the anchor store, moving lastSurveyAt forward', async () => {
    const a = throwingAdapter('packs')
    const { svc, store } = build([a], { now: () => 500 })
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    expect((store.load().data as Record<string, unknown>).packs).toEqual({
      lastSurveyAt: 500,
      consecutiveFailures: 1
    })
    svc.stop()
  })

  it('does not stop a second, healthy adapter from being surveyed in the same tick', async () => {
    const bad = throwingAdapter('packs')
    const blockedCandidate: Candidate = {
      domain: 'hive-skill',
      key: 'skill/x',
      label: 'X',
      from: null,
      to: '1',
      verdict: 'blocked',
      reason: { kind: 'auth' }
    }
    const good = fakeAdapter('hive', [blockedCandidate])
    const { svc, store } = build([bad, good], { now: () => 999 })
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(good.survey).toHaveBeenCalledTimes(1)
    expect(svc.payload().blocked).toEqual([blockedCandidate])
    expect((store.load().data as Record<string, unknown>).hive).toEqual({
      lastSurveyAt: 999,
      consecutiveFailures: 0
    })
    expect((store.load().data as Record<string, unknown>).packs).toEqual({
      lastSurveyAt: 999,
      consecutiveFailures: 1
    })
    svc.stop()
  })

  it('a failure followed by a success resets consecutiveFailures to 0', async () => {
    let t = 0
    const survey = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([])
    const a: CurrencyAdapter = {
      id: 'packs',
      survey,
      apply: vi.fn(async () => ({ ok: true as const }))
    }
    const { svc, store } = build([a], { now: () => t })
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    expect((store.load().data as Record<string, unknown>).packs).toEqual({
      lastSurveyAt: 0,
      consecutiveFailures: 1
    })
    // First doubling window: due again exactly one interval after the failed anchor.
    t = SIX_H + 1
    await vi.advanceTimersByTimeAsync(2_000)
    expect(survey).toHaveBeenCalledTimes(2)
    expect((store.load().data as Record<string, unknown>).packs).toEqual({
      lastSurveyAt: t,
      consecutiveFailures: 0
    })
    svc.stop()
  })
})
