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

const adoption = (key: string): Candidate => ({
  domain: 'hive-skill',
  key,
  label: key,
  from: null, // null ⇒ a brand-new adoption
  to: 'abc',
  verdict: 'clean'
})

const update = (key: string): Candidate => ({
  domain: 'hive-skill',
  key,
  label: key,
  from: 'old',
  to: 'abc',
  verdict: 'clean'
})

function build(candidates: Candidate[], onAdopted: (n: number) => void): CurrencyService {
  const adapter: CurrencyAdapter = {
    id: 'hive',
    survey: vi.fn(async () => candidates),
    apply: vi.fn(async () => ({ ok: true as const }))
  }
  return new CurrencyService({
    adapters: [adapter],
    anchors: new CurrencyAnchorStore(memStore()),
    autoEnabled: () => true,
    isQuiet: () => true,
    now: () => 0,
    tickMs: 1_000,
    intervalMs: SIX_H,
    onAdopted
  })
}

describe('adoption reporting', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reports the count of brand-new adoptions in a batch', async () => {
    const seen: number[] = []
    const svc = build([adoption('skill/a'), adoption('skill/b')], (n) => seen.push(n))
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([2])
    svc.stop()
  })

  it('does NOT report an update to an already-installed item', async () => {
    const seen: number[] = []
    const svc = build([update('skill/a')], (n) => seen.push(n))
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([])
    svc.stop()
  })

  it('counts only the adoptions in a mixed batch', async () => {
    const seen: number[] = []
    const svc = build([adoption('skill/a'), update('skill/b')], (n) => seen.push(n))
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([1])
    svc.stop()
  })

  it('does not report an adoption whose apply refused', async () => {
    const seen: number[] = []
    const adapter: CurrencyAdapter = {
      id: 'hive',
      survey: vi.fn(async () => [adoption('skill/a')]),
      apply: vi.fn(async () => ({
        ok: false as const,
        error: 'nope',
        reason: { kind: 'local-edits' as const }
      }))
    }
    const svc = new CurrencyService({
      adapters: [adapter],
      anchors: new CurrencyAnchorStore(memStore()),
      autoEnabled: () => true,
      isQuiet: () => true,
      now: () => 0,
      tickMs: 1_000,
      intervalMs: SIX_H,
      onAdopted: (n) => seen.push(n)
    })
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([])
    svc.stop()
  })
})
