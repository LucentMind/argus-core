import { describe, it, expect, vi } from 'vitest'
import { DiagnosticsHistoryRing, OBJECT_CAP } from '../history'
import {
  DIAGNOSTICS_BUCKET_COUNT as BUCKET_COUNT,
  DIAGNOSTICS_BUCKET_MS as BUCKET_MS,
  DIAGNOSTICS_RETENTION_MS as RETENTION_MS
} from '../../../../shared/diagnostics'
import type { DiagnosticsObject } from '../../../../shared/diagnostics'

describe('DiagnosticsHistoryRing — totals', () => {
  it('folds the peak CPU and the mean RSS within one bucket', () => {
    const ring = new DiagnosticsHistoryRing()
    ring.record({ atMs: 0, cpuPercent: 10, rssBytes: 100, processCount: 3, objects: [] })
    ring.record({ atMs: 1_000, cpuPercent: 90, rssBytes: 300, processCount: 5, objects: [] })
    ring.record({ atMs: 2_000, cpuPercent: 20, rssBytes: 200, processCount: 4, objects: [] })

    const h = ring.read(4_999, BUCKET_MS)
    expect(h.bucketCount).toBe(1)
    // Max for CPU: a driver pinned at 90% for one second is the event, and a mean
    // over the bucket would smooth it into an 40% blip and hide it.
    expect(h.total.cpuPercent).toEqual([90])
    // Mean for RSS: the trend is the signal, so the representative value is the average.
    expect(h.total.rssBytes).toEqual([200])
    expect(h.total.processCount).toEqual([5])
  })

  it('reports an empty bucket as null, never as zero', () => {
    const ring = new DiagnosticsHistoryRing()
    ring.record({ atMs: 0, cpuPercent: 4, rssBytes: 100, processCount: 2, objects: [] })
    // 15s later — the slow-tier cadence, which leaves two empty buckets behind it.
    ring.record({ atMs: 15_000, cpuPercent: 6, rssBytes: 120, processCount: 2, objects: [] })

    const h = ring.read(19_999, 20_000)
    expect(h.total.cpuPercent).toEqual([4, null, null, 6])
    expect(h.total.rssBytes).toEqual([100, null, null, 120])
  })

  it('resets a slot reused after a full wrap instead of accumulating into it', () => {
    // THE test for this file. A 720-slot ring exercised only across its first 720
    // buckets proves nothing about the mechanism that makes it a ring.
    const ring = new DiagnosticsHistoryRing()
    ring.record({ atMs: 0, cpuPercent: 99, rssBytes: 9_000, processCount: 40, objects: [] })
    ring.record({ atMs: RETENTION_MS, cpuPercent: 1, rssBytes: 10, processCount: 1, objects: [] })

    const h = ring.read(RETENTION_MS + BUCKET_MS - 1, BUCKET_MS)
    expect(h.total.cpuPercent).toEqual([1]) // not 99 — the old max did not survive
    expect(h.total.rssBytes).toEqual([10]) // not (9000 + 10) / 2
    expect(h.total.processCount).toEqual([1])
  })

  it('drops a sample that has aged out of the retention window', () => {
    const ring = new DiagnosticsHistoryRing()
    ring.record({ atMs: 0, cpuPercent: 50, rssBytes: 500, processCount: 9, objects: [] })

    const h = ring.read(RETENTION_MS + BUCKET_MS, RETENTION_MS)
    expect(h.total.cpuPercent.every((v) => v === null)).toBe(true)
  })

  it('clamps the requested window at both ends', () => {
    const ring = new DiagnosticsHistoryRing()
    expect(ring.read(0, 1).bucketCount).toBe(1)
    expect(ring.read(0, RETENTION_MS * 10).bucketCount).toBe(BUCKET_COUNT)
  })

  it('survives a non-finite window from an untrusted caller', () => {
    // windowMs arrives over IPC from the renderer. Math.ceil(NaN / n) is NaN and
    // `new Array(NaN)` throws a RangeError, which would take out the IPC handler.
    const ring = new DiagnosticsHistoryRing()
    expect(() => ring.read(0, Number.NaN)).not.toThrow()
    expect(ring.read(0, Number.NaN).bucketCount).toBe(1)
  })

  it('resets instead of quietly corrupting when the clock steps backwards past retention', () => {
    // An NTP correction or manual clock change can move the wall clock backwards by more
    // than a full hour. Left unguarded, read()'s lastBucket would derive from the new,
    // earlier clock — leaving the chart looking empty — while ordinary future writes
    // slowly clobber the slots that still hold the real recent hour, with no signal that
    // it happened.
    const ring = new DiagnosticsHistoryRing()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const lateMs = RETENTION_MS * 10
    ring.record({ atMs: lateMs, cpuPercent: 99, rssBytes: 900, processCount: 5, objects: [] })

    // Step backwards by more than a full retention window.
    const earlyMs = lateMs - RETENTION_MS - BUCKET_MS * 5
    ring.record({ atMs: earlyMs, cpuPercent: 3, rssBytes: 30, processCount: 1, objects: [] })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [message] = warnSpy.mock.calls[0]
    // Both bucket indices are named in the one warning, per spec.
    expect(message).toContain(String(Math.floor(lateMs / BUCKET_MS)))
    expect(message).toContain(String(Math.floor(earlyMs / BUCKET_MS)))

    // The reset actually happened: reading right after the jump sees only the NEW data,
    // not a stale value smuggled through a slot the modulus happens to collide with.
    const h = ring.read(earlyMs + BUCKET_MS - 1, BUCKET_MS)
    expect(h.total.cpuPercent).toEqual([3])

    warnSpy.mockRestore()
  })

  it('does not reset on an ordinary forward gap, even a long one', () => {
    const ring = new DiagnosticsHistoryRing()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    ring.record({ atMs: 0, cpuPercent: 10, rssBytes: 100, processCount: 1, objects: [] })
    // Forward by less than a full retention window — an ordinary gap, not a clock step.
    ring.record({
      atMs: RETENTION_MS - BUCKET_MS,
      cpuPercent: 20,
      rssBytes: 200,
      processCount: 2,
      objects: []
    })

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('aligns `from` to a bucket boundary and covers `now`', () => {
    const ring = new DiagnosticsHistoryRing()
    const h = ring.read(1_234_567, 60_000)
    expect(h.from % BUCKET_MS).toBe(0)
    expect(h.from).toBeLessThanOrEqual(1_234_567)
    expect(h.from + h.bucketCount * BUCKET_MS).toBeGreaterThan(1_234_567)
    expect(h.bucketMs).toBe(BUCKET_MS)
    expect(h.total.cpuPercent).toHaveLength(h.bucketCount)
  })
})

function obj(id: string, over: Partial<DiagnosticsObject> = {}): DiagnosticsObject {
  return {
    id,
    kind: 'driver',
    label: id,
    orphan: false,
    inferred: false,
    terminable: false,
    busy: false,
    rootPid: 1,
    processCount: 1,
    cpuPercent: 5,
    rssBytes: 100,
    uptimeMs: 1_000,
    ...over
  }
}

describe('DiagnosticsHistoryRing — objects', () => {
  it('records a series per object, keyed on the row id', () => {
    const ring = new DiagnosticsHistoryRing()
    ring.record({
      atMs: 0,
      cpuPercent: 9,
      rssBytes: 300,
      processCount: 2,
      objects: [
        obj('a', { cpuPercent: 4, rssBytes: 100 }),
        obj('b', { cpuPercent: 5, rssBytes: 200 })
      ]
    })

    const h = ring.read(BUCKET_MS - 1, BUCKET_MS)
    expect(h.objects.map((o) => o.id).sort()).toEqual(['a', 'b'])
    expect(h.objects.find((o) => o.id === 'a')?.cpuPercent).toEqual([4])
    expect(h.objects.find((o) => o.id === 'b')?.rssBytes).toEqual([200])
  })

  it('omits an object with no data inside the requested window', () => {
    // Otherwise a 5-minute window ships 60 nulls per object describing an hour ago.
    const ring = new DiagnosticsHistoryRing()
    ring.record({ atMs: 0, cpuPercent: 1, rssBytes: 10, processCount: 1, objects: [obj('old')] })
    ring.record({
      atMs: 600_000,
      cpuPercent: 1,
      rssBytes: 10,
      processCount: 1,
      objects: [obj('recent')]
    })

    const h = ring.read(600_000, 60_000)
    expect(h.objects.map((o) => o.id)).toEqual(['recent'])
  })

  it('marks an object dead once it stops appearing in samples', () => {
    const ring = new DiagnosticsHistoryRing()
    ring.record({
      atMs: 0,
      cpuPercent: 2,
      rssBytes: 20,
      processCount: 2,
      objects: [obj('gone'), obj('stays')]
    })
    ring.record({
      atMs: 10_000,
      cpuPercent: 1,
      rssBytes: 10,
      processCount: 1,
      objects: [obj('stays')]
    })

    const h = ring.read(10_000, 60_000)
    expect(h.objects.find((o) => o.id === 'gone')?.live).toBe(false)
    expect(h.objects.find((o) => o.id === 'stays')?.live).toBe(true)
  })

  it('takes the latest label, so a renamed panel does not keep its old title', () => {
    const ring = new DiagnosticsHistoryRing()
    ring.record({
      atMs: 0,
      cpuPercent: 1,
      rssBytes: 10,
      processCount: 1,
      objects: [obj('p', { label: 'Panel: old' })]
    })
    ring.record({
      atMs: 5_000,
      cpuPercent: 1,
      rssBytes: 10,
      processCount: 1,
      objects: [obj('p', { label: 'Panel: new' })]
    })

    const h = ring.read(5_000, 60_000)
    expect(h.objects.find((o) => o.id === 'p')?.label).toBe('Panel: new')
  })

  it('evicts dead history before live under id churn', () => {
    // A crash-looping process mints a fresh `pid:startTimeMs` id every respawn — exactly
    // the signal this page exists to surface. An eviction policy that did not order by
    // last-seen would throw away the long-lived row's history instead of the churn's.
    const ring = new DiagnosticsHistoryRing()
    const ticks = OBJECT_CAP * 2
    for (let i = 0; i < ticks; i++) {
      ring.record({
        atMs: i * BUCKET_MS,
        cpuPercent: 1,
        rssBytes: 10,
        processCount: 2,
        objects: [obj('stable'), obj(`churn-${i}`)]
      })
    }

    const h = ring.read(ticks * BUCKET_MS, RETENTION_MS)
    expect(h.objects.find((o) => o.id === 'stable')).toBeDefined()
    expect(h.objects.length).toBeLessThanOrEqual(OBJECT_CAP)
    // The oldest churn ids are gone; the newest are not.
    expect(h.objects.find((o) => o.id === 'churn-0')).toBeUndefined()
    expect(h.objects.find((o) => o.id === `churn-${ticks - 1}`)).toBeDefined()
  })

  it('starts a fresh series when an evicted id is seen again', () => {
    const ring = new DiagnosticsHistoryRing()
    ring.record({
      atMs: 0,
      cpuPercent: 1,
      rssBytes: 10,
      processCount: 1,
      objects: [obj('x', { cpuPercent: 77 })]
    })
    for (let i = 1; i <= OBJECT_CAP + 1; i++) {
      ring.record({
        atMs: i * BUCKET_MS,
        cpuPercent: 1,
        rssBytes: 10,
        processCount: 1,
        objects: [obj(`filler-${i}`)]
      })
    }
    const after = (OBJECT_CAP + 2) * BUCKET_MS
    ring.record({
      atMs: after,
      cpuPercent: 1,
      rssBytes: 10,
      processCount: 1,
      objects: [obj('x', { cpuPercent: 3 })]
    })

    const h = ring.read(after, RETENTION_MS)
    const x = h.objects.find((o) => o.id === 'x')
    expect(x).toBeDefined()
    // The pre-eviction 77 is gone rather than resurrected.
    expect(x?.cpuPercent.filter((v) => v !== null)).toEqual([3])
  })
})
