import { describe, it, expect } from 'vitest'
import { CurrencyAnchorStore, type AnchorFile } from '../anchors'

const SIX_H = 21_600_000

/** Structural stand-in for JsonFileStore: keeps the written object in memory. */
function fakeStore(initial: unknown = {}): {
  load: () => { data: unknown; error: string | null }
  write: (o: unknown) => void
  current: () => AnchorFile
} {
  let data: unknown = initial
  return {
    load: () => ({ data, error: null }),
    write: (o) => {
      data = JSON.parse(JSON.stringify(o))
    },
    current: () => data as AnchorFile
  }
}

describe('CurrencyAnchorStore', () => {
  it('reports a never-surveyed adapter as due now', () => {
    const s = new CurrencyAnchorStore(fakeStore())
    expect(s.dueAt('packs', SIX_H)).toBe(0)
    expect(s.get('packs')).toEqual({ lastSurveyAt: null, consecutiveFailures: 0 })
  })

  it('persists a success immediately', () => {
    const store = fakeStore()
    new CurrencyAnchorStore(store).recordSuccess('hive', 5_000)
    expect(store.current().hive).toEqual({ lastSurveyAt: 5_000, consecutiveFailures: 0 })
  })

  it('schedules the next survey one interval after a success', () => {
    const s = new CurrencyAnchorStore(fakeStore())
    s.recordSuccess('hive', 5_000)
    expect(s.dueAt('hive', SIX_H)).toBe(5_000 + SIX_H)
  })

  it('backs off 6h then 12h then 24h and stays there', () => {
    const s = new CurrencyAnchorStore(fakeStore())
    s.recordFailure('core', 1_000)
    expect(s.dueAt('core', SIX_H)).toBe(1_000 + SIX_H)
    s.recordFailure('core', 2_000)
    expect(s.dueAt('core', SIX_H)).toBe(2_000 + SIX_H * 2)
    s.recordFailure('core', 3_000)
    expect(s.dueAt('core', SIX_H)).toBe(3_000 + SIX_H * 4)
    s.recordFailure('core', 4_000)
    expect(s.dueAt('core', SIX_H)).toBe(4_000 + SIX_H * 4)
  })

  it('resets the ladder on the first success', () => {
    const s = new CurrencyAnchorStore(fakeStore())
    s.recordFailure('core', 1_000)
    s.recordFailure('core', 2_000)
    s.recordSuccess('core', 3_000)
    expect(s.get('core').consecutiveFailures).toBe(0)
    expect(s.dueAt('core', SIX_H)).toBe(3_000 + SIX_H)
  })

  it('reads anchors written by a previous process', () => {
    const s = new CurrencyAnchorStore(
      fakeStore({ packs: { lastSurveyAt: 9_000, consecutiveFailures: 1 } })
    )
    expect(s.get('packs')).toEqual({ lastSurveyAt: 9_000, consecutiveFailures: 1 })
  })

  it('reports the newest successful survey across adapters', () => {
    const s = new CurrencyAnchorStore(fakeStore())
    s.recordSuccess('core', 1_000)
    s.recordSuccess('hive', 7_000)
    s.recordSuccess('packs', 4_000)
    expect(s.lastSurveyAt()).toBe(7_000)
  })

  it('tolerates a corrupt file by treating every adapter as never surveyed', () => {
    const s = new CurrencyAnchorStore(fakeStore({ packs: 'nonsense' }))
    expect(s.get('packs')).toEqual({ lastSurveyAt: null, consecutiveFailures: 0 })
  })

  it('does not let a failure move the reported "last successful survey" forward', () => {
    const s = new CurrencyAnchorStore(fakeStore())
    s.recordSuccess('packs', 1_000)
    // A later FAILURE still advances the per-adapter scheduling anchor (for backoff)...
    s.recordFailure('packs', 9_000)
    expect(s.get('packs').lastSurveyAt).toBe(9_000)
    // ...but must not make the status line claim a check succeeded at 9_000.
    expect(s.lastSurveyAt()).toBe(1_000)
  })

  it('reports null for "last successful survey" when nothing has ever succeeded, even after failures', () => {
    const s = new CurrencyAnchorStore(fakeStore())
    s.recordFailure('packs', 500)
    s.recordFailure('hive', 700)
    expect(s.lastSurveyAt()).toBeNull()
  })
})
