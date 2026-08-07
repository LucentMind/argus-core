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

/** Runs worth drawing at all: a non-positive axis or an empty series has nothing to draw
 *  regardless of how the caller wants to render each run. Length filtering is the
 *  caller's job — `projectSeries` and `projectArea` want different minimums (see
 *  each's own comment below). */
function drawableRuns(series: DiagnosticsSeries, p: Projection): SeriesPoint[][] {
  if (!(p.max > 0) || series.length === 0) return []
  return splitRuns(series, p.bridge)
}

export function projectSeries(series: DiagnosticsSeries, p: Projection): string {
  const { x, y } = scales(series.length, p)
  return drawableRuns(series, p)
    .map((run) => {
      const [x0, y0] = [x(run[0].i), y(run[0].v)]
      if (run.length === 1) {
        // A single-point run has no width to draw as a line, but it is real data — most
        // often a process whose entire life fit inside one or two 5s buckets, which is
        // exactly the crash-loop churn this ring exists to surface. Dropping it here
        // would render that row as a label and four em-dashes with nothing in between:
        // zero information for the flagship scenario. `M x yL x y` is a zero-length
        // segment; both consuming components (Sparkline, TimelineChart) set
        // strokeLinecap="round", and a round cap on a zero-length subpath paints a dot
        // of diameter strokeWidth at that point (SVG spec behaviour for degenerate
        // subpaths — a butt cap would draw nothing, which is why this depends on the
        // linecap staying "round").
        return `M${x0} ${y0}L${x0} ${y0}`
      }
      return (
        `M${x0} ${y0}` +
        run
          .slice(1)
          .map((pt) => `L${x(pt.i)} ${y(pt.v)}`)
          .join('')
      )
    })
    .join('')
}

export function projectArea(series: DiagnosticsSeries, p: Projection): string {
  const { x, y } = scales(series.length, p)
  const base = r2(p.height)
  return (
    drawableRuns(series, p)
      // Unlike projectSeries, a lone point has no area: a zero-width filled region is
      // meaningless (and a "M x yL x yL x yZ" would flicker as an invisible sliver, not a
      // dot — area has no cap to render one).
      .filter((run) => run.length >= 2)
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
  )
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
  // Belt-and-braces, not currently reachable: base = 2^floor(log2(peak)) always satisfies
  // base <= peak < 2*base, so the `m = 2` arm of the loop above always returns first.
  // Kept as a guard against a future change to the step list rather than trusting that
  // invariant to hold forever silently.
  return base * 2
}

/** Index of the newest bucket carrying data, or -1. Used to order ended rows by when
 *  they actually stopped. */
export function lastIndexWithData(series: DiagnosticsSeries): number {
  for (let i = series.length - 1; i >= 0; i--) if (series[i] !== null) return i
  return -1
}
