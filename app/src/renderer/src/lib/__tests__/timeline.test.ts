import { describe, it, expect } from 'vitest'
import {
  bridgeBuckets,
  lastIndexWithData,
  niceMax,
  projectArea,
  projectSeries,
  seriesDenominator,
  splitRuns
} from '../timeline'
import { DIAGNOSTICS_BUCKET_MS } from '../../../../shared/diagnostics'

const P = { width: 100, height: 20, max: 10, bridge: 3 }

describe('seriesDenominator', () => {
  it('yields the divisor: N buckets span N-1 gaps, and never yields 0', () => {
    expect(seriesDenominator(0)).toBe(1)
    expect(seriesDenominator(1)).toBe(1)
    expect(seriesDenominator(5)).toBe(4)
  })
})

describe('bridgeBuckets', () => {
  it('draws through a slow-tier gap and breaks on a real outage', () => {
    // 15s cadence over 5s buckets leaves 2 empty buckets between samples — that is the
    // page-closed heartbeat, not a break. 20s spacing (3 empties) is the limit.
    expect(bridgeBuckets(DIAGNOSTICS_BUCKET_MS)).toBe(3)
    expect(bridgeBuckets(0)).toBe(0)
  })
})

describe('splitRuns', () => {
  it('joins runs separated by a bridgeable gap and splits longer ones', () => {
    const runs = splitRuns([1, null, null, 2, null, null, null, null, 3], 3)
    expect(runs).toHaveLength(2)
    expect(runs[0].map((p) => p.v)).toEqual([1, 2])
    expect(runs[1].map((p) => p.v)).toEqual([3])
  })

  it('treats a non-finite value as absent', () => {
    const runs = splitRuns([1, Number.NaN, 2], 3)
    expect(runs[0].map((p) => p.v)).toEqual([1, 2])
  })
})

describe('projectSeries', () => {
  it('never emits NaN into a path', () => {
    // A `d` attribute containing NaN renders nothing and raises nothing — the single
    // most likely way this feature ships silently broken.
    const hostile = [1, Number.NaN, 3, Number.POSITIVE_INFINITY, 5, null, 7]
    expect(projectSeries(hostile, P)).not.toContain('NaN')
    expect(projectArea(hostile, P)).not.toContain('NaN')
  })

  it('returns an empty path when there is nothing to draw', () => {
    expect(projectSeries([], P)).toBe('')
    expect(projectSeries([null, null, null], P)).toBe('')
    // A lone point has no width; an "M x y" with no line command draws nothing anyway.
    expect(projectSeries([5], P)).toBe('')
    expect(projectSeries([1, 2], { ...P, max: 0 })).toBe('')
  })

  it('maps the first and last buckets to the full width and inverts the y axis', () => {
    const d = projectSeries([0, 10], P)
    // y is inverted: 0 sits on the baseline (height), max sits at the top (0).
    expect(d).toBe('M0 20L100 0')
  })

  it('clamps a value above the axis maximum to the top edge', () => {
    const d = projectSeries([0, 999], P)
    expect(d).toBe('M0 20L100 0')
    expect(d).not.toContain('-')
  })

  it('starts a new subpath after an unbridgeable gap', () => {
    const d = projectSeries([1, null, null, null, null, 2, 3], P)
    expect(d.match(/M/g)).toHaveLength(1) // the lone leading point is dropped
    const d2 = projectSeries([1, 2, null, null, null, null, 3, 4], P)
    expect(d2.match(/M/g)).toHaveLength(2)
  })
})

describe('projectArea', () => {
  it('closes each run down to the baseline', () => {
    const d = projectArea([0, 10], P)
    expect(d).toBe('M0 20L0 20L100 0L100 20Z')
  })
})

describe('niceMax', () => {
  it('gives an idle CPU chart a real axis instead of a blank one', () => {
    expect(niceMax([0, 0, 0], 'percent')).toBe(5)
    expect(niceMax([null, null], 'percent')).toBe(5)
  })

  it('snaps CPU to a readable step', () => {
    expect(niceMax([3.2], 'percent')).toBe(5)
    expect(niceMax([7], 'percent')).toBe(10)
    expect(niceMax([40], 'percent')).toBe(50)
    expect(niceMax([140], 'percent')).toBe(150)
  })

  it('snaps bytes to a power of two or its half step', () => {
    // 2^29 = 536,870,912 is the largest power of two below 6e8, and 1.5 × 2^29 =
    // 805,306,368 is the first step at or above it. Working these through by hand is
    // the point: the obvious-looking "round up to 1 GB" is NOT what the rule produces.
    expect(niceMax([600_000_000], 'bytes')).toBe(1.5 * 2 ** 29)
    expect(niceMax([1_600_000_000], 'bytes')).toBe(1.5 * 2 ** 30)
    expect(niceMax([2 ** 30], 'bytes')).toBe(2 ** 30) // an exact power is its own axis top
    expect(niceMax([0], 'bytes')).toBe(1024 * 1024)
  })
})

describe('lastIndexWithData', () => {
  it('finds the last non-null bucket', () => {
    expect(lastIndexWithData([1, null, 3, null])).toBe(2)
    expect(lastIndexWithData([null, null])).toBe(-1)
  })
})
