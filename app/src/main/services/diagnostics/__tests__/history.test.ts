import { describe, it, expect } from 'vitest'
import { DiagnosticsHistoryRing } from '../history'
import {
  DIAGNOSTICS_BUCKET_COUNT as BUCKET_COUNT,
  DIAGNOSTICS_BUCKET_MS as BUCKET_MS,
  DIAGNOSTICS_RETENTION_MS as RETENTION_MS
} from '../../../../shared/diagnostics'

describe('DiagnosticsHistoryRing — totals', () => {
  it('folds the peak CPU and the mean RSS within one bucket', () => {
    const ring = new DiagnosticsHistoryRing()
    ring.record({ atMs: 0, cpuPercent: 10, rssBytes: 100, processCount: 3 })
    ring.record({ atMs: 1_000, cpuPercent: 90, rssBytes: 300, processCount: 5 })
    ring.record({ atMs: 2_000, cpuPercent: 20, rssBytes: 200, processCount: 4 })

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
    ring.record({ atMs: 0, cpuPercent: 4, rssBytes: 100, processCount: 2 })
    // 15s later — the slow-tier cadence, which leaves two empty buckets behind it.
    ring.record({ atMs: 15_000, cpuPercent: 6, rssBytes: 120, processCount: 2 })

    const h = ring.read(19_999, 20_000)
    expect(h.total.cpuPercent).toEqual([4, null, null, 6])
    expect(h.total.rssBytes).toEqual([100, null, null, 120])
  })

  it('resets a slot reused after a full wrap instead of accumulating into it', () => {
    // THE test for this file. A 720-slot ring exercised only across its first 720
    // buckets proves nothing about the mechanism that makes it a ring.
    const ring = new DiagnosticsHistoryRing()
    ring.record({ atMs: 0, cpuPercent: 99, rssBytes: 9_000, processCount: 40 })
    ring.record({ atMs: RETENTION_MS, cpuPercent: 1, rssBytes: 10, processCount: 1 })

    const h = ring.read(RETENTION_MS + BUCKET_MS - 1, BUCKET_MS)
    expect(h.total.cpuPercent).toEqual([1]) // not 99 — the old max did not survive
    expect(h.total.rssBytes).toEqual([10]) // not (9000 + 10) / 2
    expect(h.total.processCount).toEqual([1])
  })

  it('drops a sample that has aged out of the retention window', () => {
    const ring = new DiagnosticsHistoryRing()
    ring.record({ atMs: 0, cpuPercent: 50, rssBytes: 500, processCount: 9 })

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
