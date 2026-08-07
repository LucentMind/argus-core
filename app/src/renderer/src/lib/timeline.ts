import { DIAGNOSTICS_MAX_BRIDGE_MS, type DiagnosticsSeries } from '../../../shared/diagnostics'

export type SeriesPoint = { i: number; v: number }

/** The x-axis divisor: N buckets span N-1 gaps. Shared so the drawn path and any
 *  hover mapping cannot disagree about where a bucket sits. */
export function seriesDenominator(length: number): number {
  return length > 1 ? length - 1 : 1
}

export type Projection = {
  width: number
  height: number
  /** Top of the y axis in data units. A non-positive max yields an empty path. */
  max: number
  /** Longest run of empty buckets drawn through before the line breaks. */
  bridge: number
}

/**
 * How many empty buckets a chart draws through.
 *
 * A run of n empties means the flanking samples are (n + 1) buckets apart, so the run is
 * bridgeable while (n + 1) * bucketMs <= DIAGNOSTICS_MAX_BRIDGE_MS. At the shipped 5s
 * bucket that is 3 — enough for the 15s page-closed heartbeat (2 empties) and for a 20s
 * spacing, and not enough for a real outage.
 */
export function bridgeBuckets(bucketMs: number): number {
  if (!(bucketMs > 0)) return 0
  return Math.max(0, Math.floor(DIAGNOSTICS_MAX_BRIDGE_MS / bucketMs) - 1)
}

export function splitRuns(series: DiagnosticsSeries, bridge: number): SeriesPoint[][] {
  const runs: SeriesPoint[][] = []
  let current: SeriesPoint[] | null = null
  let gap = 0
  for (let i = 0; i < series.length; i++) {
    const v = series[i]
    // Number.isFinite also rejects NaN and Infinity. A non-finite value reaching a `d`
    // attribute renders nothing and raises nothing, so it is filtered at the source.
    if (v === null || !Number.isFinite(v)) {
      gap += 1
      continue
    }
    if (current === null || gap > bridge) {
      current = []
      runs.push(current)
    }
    current.push({ i, v })
    gap = 0
  }
  return runs
}

/** Two decimals is below one device pixel at every size this renders, and keeps the
 *  `d` string short enough to diff by eye. */
const r2 = (n: number): number => Math.round(n * 100) / 100

function scales(
  length: number,
  p: Projection
): { x: (i: number) => number; y: (v: number) => number } {
  const denom = seriesDenominator(length)
  return {
    x: (i) => r2((i / denom) * p.width),
    y: (v) => r2(p.height - (Math.min(Math.max(v, 0), p.max) / p.max) * p.height)
  }
}

/** Runs worth drawing: a single point has no width and would emit a bare `M` that draws
 *  nothing while still bloating the attribute. */
function drawableRuns(series: DiagnosticsSeries, p: Projection): SeriesPoint[][] {
  if (!(p.max > 0) || series.length === 0) return []
  return splitRuns(series, p.bridge).filter((run) => run.length >= 2)
}

export function projectSeries(series: DiagnosticsSeries, p: Projection): string {
  const { x, y } = scales(series.length, p)
  return drawableRuns(series, p)
    .map(
      (run) =>
        `M${x(run[0].i)} ${y(run[0].v)}` +
        run
          .slice(1)
          .map((pt) => `L${x(pt.i)} ${y(pt.v)}`)
          .join('')
    )
    .join('')
}

export function projectArea(series: DiagnosticsSeries, p: Projection): string {
  const { x, y } = scales(series.length, p)
  const base = r2(p.height)
  return drawableRuns(series, p)
    .map((run) => {
      const last = run[run.length - 1]
      const head = `M${x(run[0].i)} ${base}L${x(run[0].i)} ${y(run[0].v)}`
      const body = run
        .slice(1)
        .map((pt) => `L${x(pt.i)} ${y(pt.v)}`)
        .join('')
      return `${head}${body}L${x(last.i)} ${base}Z`
    })
    .join('')
}

const PERCENT_STEPS = [5, 10, 25, 50, 100]

/**
 * The top of the y axis.
 *
 * An all-zero CPU series still returns the smallest step rather than 0, so an idle chart
 * draws a flat line along its baseline instead of rendering blank — a blank chart reads
 * as "broken", which is the wrong message for "nothing is using the CPU".
 */
export function niceMax(series: DiagnosticsSeries, kind: 'percent' | 'bytes'): number {
  let peak = 0
  for (const v of series) if (v !== null && Number.isFinite(v) && v > peak) peak = v

  if (kind === 'percent') {
    for (const step of PERCENT_STEPS) if (peak <= step) return step
    return Math.ceil(peak / 25) * 25
  }

  if (peak <= 0) return 1024 * 1024
  // Binary steps, not decimal: 512 MB / 1 GB / 1.5 GB read as memory sizes, where
  // 500,000,000 does not.
  const base = 2 ** Math.floor(Math.log2(peak))
  for (const m of [1, 1.5, 2]) if (peak <= m * base) return m * base
  return base * 2
}

/** Index of the newest bucket carrying data, or -1. Used to order ended rows by when
 *  they actually stopped. */
export function lastIndexWithData(series: DiagnosticsSeries): number {
  for (let i = series.length - 1; i >= 0; i--) if (series[i] !== null) return i
  return -1
}
