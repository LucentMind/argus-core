import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CurrencyService } from '../service'
import { CurrencyAnchorStore } from '../anchors'
import type { CurrencyAdapter } from '../adapter'
import type { Candidate } from '../../../../../shared/currency'

const SIX_H = 21_600_000

const clean = (key: string): Candidate => ({
  domain: 'pack',
  key,
  label: key,
  from: '1.0.0',
  to: '1.1.0',
  verdict: 'clean'
})

const blockedCandidate: Candidate = {
  domain: 'hive-reference',
  key: 'reference/style.md',
  label: 'style.md',
  from: 'a',
  to: 'b',
  verdict: 'blocked',
  reason: { kind: 'local-edits' }
}

function memStore(): { load: () => { data: unknown; error: null }; write: (o: unknown) => void } {
  let data: unknown = {}
  return {
    load: () => ({ data, error: null }),
    write: (o: unknown) => {
      data = JSON.parse(JSON.stringify(o))
    }
  }
}

function build(
  adapter: CurrencyAdapter,
  over: { quiet?: () => boolean; now?: () => number } = {}
): CurrencyService {
  return new CurrencyService({
    adapters: [adapter],
    anchors: new CurrencyAnchorStore(memStore()),
    autoEnabled: () => true,
    isQuiet: over.quiet ?? (() => true),
    now: over.now ?? (() => 0),
    tickMs: 1_000,
    intervalMs: SIX_H
  })
}

describe('CurrencyService applying', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('applies clean candidates when quiet', async () => {
    const adapter: CurrencyAdapter = {
      id: 'packs',
      survey: vi.fn(async () => [clean('a'), clean('b')]),
      apply: vi.fn(async () => ({ ok: true as const }))
    }
    const svc = build(adapter)
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(adapter.apply).toHaveBeenCalledTimes(2)
    svc.stop()
  })

  it('never applies a blocked candidate', async () => {
    const adapter: CurrencyAdapter = {
      id: 'hive',
      survey: vi.fn(async () => [blockedCandidate]),
      apply: vi.fn(async () => ({ ok: true as const }))
    }
    const svc = build(adapter)
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(adapter.apply).not.toHaveBeenCalled()
    expect(svc.payload().blocked).toEqual([blockedCandidate])
    svc.stop()
  })

  it('holds a clean candidate until the app is quiet', async () => {
    let quiet = false
    const adapter: CurrencyAdapter = {
      id: 'packs',
      survey: vi.fn(async () => [clean('a')]),
      apply: vi.fn(async () => ({ ok: true as const }))
    }
    const svc = build(adapter, { quiet: () => quiet })
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(adapter.apply).not.toHaveBeenCalled()
    quiet = true
    await vi.advanceTimersByTimeAsync(1_000)
    expect(adapter.apply).toHaveBeenCalledTimes(1)
    // It surveyed once; the second tick applied without re-surveying.
    expect(adapter.survey).toHaveBeenCalledTimes(1)
    svc.stop()
  })

  it('stops a batch mid-way when a run starts, and finishes it on the next quiet tick', async () => {
    let quiet = true
    const applied: string[] = []
    const adapter: CurrencyAdapter = {
      id: 'packs',
      survey: vi.fn(async () => [clean('a'), clean('b'), clean('c')]),
      apply: vi.fn(async (c: Candidate) => {
        applied.push(c.key)
        // A run starts while the first item is being written.
        if (c.key === 'a') quiet = false
        return { ok: true as const }
      })
    }
    const svc = build(adapter, { quiet: () => quiet })
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(applied).toEqual(['a'])
    quiet = true
    await vi.advanceTimersByTimeAsync(1_000)
    expect(applied).toEqual(['a', 'b', 'c'])
    svc.stop()
  })

  it('drops a candidate whose apply refuses it, and records the reason', async () => {
    const adapter: CurrencyAdapter = {
      id: 'hive',
      survey: vi.fn(async () => [
        { ...clean('reference/style.md'), domain: 'hive-reference' as const }
      ]),
      apply: vi.fn(async () => ({
        ok: false as const,
        error: 'edited since the survey',
        reason: { kind: 'local-edits' as const }
      }))
    }
    const svc = build(adapter)
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(adapter.apply).toHaveBeenCalledTimes(1)
    expect(svc.payload().blocked.map((c) => c.reason)).toEqual([{ kind: 'local-edits' }])
    // It must not be retried on the next tick — it is now a decision, not a pending write.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(adapter.apply).toHaveBeenCalledTimes(1)
    svc.stop()
  })

  it('serializes an auto-apply against a manual one', async () => {
    const order: string[] = []
    let release: () => void = () => {}
    const adapter: CurrencyAdapter = {
      id: 'packs',
      survey: vi.fn(async () => [clean('a')]),
      apply: vi.fn(async () => {
        order.push('auto-start')
        await new Promise<void>((r) => (release = r))
        order.push('auto-end')
        return { ok: true as const }
      })
    }
    const svc = build(adapter)
    svc.start()
    await vi.advanceTimersByTimeAsync(0)
    const manual = svc.withApplyLock(async () => void order.push('manual'))
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['auto-start'])
    release()
    await manual
    expect(order).toEqual(['auto-start', 'auto-end', 'manual'])
    svc.stop()
  })
})
