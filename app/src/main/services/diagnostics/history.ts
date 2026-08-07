import {
  DIAGNOSTICS_BUCKET_COUNT as BUCKET_COUNT,
  DIAGNOSTICS_BUCKET_MS as BUCKET_MS,
  DIAGNOSTICS_RETENTION_MS as RETENTION_MS,
  type DiagnosticsHistory,
  type DiagnosticsSeries
} from '../../../shared/diagnostics'

/** Sentinel for a slot nothing has ever been written into. */
const EMPTY = -1

type Ring = {
  /** The ABSOLUTE bucket index owning each slot. This stamp is the ring mechanism. */
  bucketIndex: Int32Array
  cpuMax: Float64Array
  rssSum: Float64Array
  rssCount: Uint32Array
  /** Totals ring only — max process count in the bucket. Absent on object rings. */
  procMax?: Int32Array
}

function makeRing(withProcessCount = false): Ring {
  return {
    bucketIndex: new Int32Array(BUCKET_COUNT).fill(EMPTY),
    cpuMax: new Float64Array(BUCKET_COUNT),
    rssSum: new Float64Array(BUCKET_COUNT),
    rssCount: new Uint32Array(BUCKET_COUNT),
    ...(withProcessCount ? { procMax: new Int32Array(BUCKET_COUNT) } : {})
  }
}

/** JS `%` keeps the sign of the dividend, and a test clock near zero can produce a
 *  negative absolute index. Without this, that would address slot -1 silently. */
function slotOf(absoluteBucket: number): number {
  const m = absoluteBucket % BUCKET_COUNT
  return m < 0 ? m + BUCKET_COUNT : m
}

/**
 * Fold one observation into its bucket.
 *
 * The stamp comparison is the whole mechanism: a slot whose stored absolute index is not
 * this one belongs to an hour ago, so it is RESET rather than accumulated into. That is
 * what removes any need for a sweep, an expiry timer, or a clearing pass.
 */
function fold(
  ring: Ring,
  absoluteBucket: number,
  cpuPercent: number,
  rssBytes: number,
  processCount = 0
): void {
  const slot = slotOf(absoluteBucket)
  if (ring.bucketIndex[slot] !== absoluteBucket) {
    ring.bucketIndex[slot] = absoluteBucket
    ring.cpuMax[slot] = cpuPercent
    ring.rssSum[slot] = rssBytes
    ring.rssCount[slot] = 1
    if (ring.procMax) ring.procMax[slot] = processCount
    return
  }
  if (cpuPercent > ring.cpuMax[slot]) ring.cpuMax[slot] = cpuPercent
  ring.rssSum[slot] += rssBytes
  ring.rssCount[slot] += 1
  if (ring.procMax && processCount > ring.procMax[slot]) ring.procMax[slot] = processCount
}

type Pick = (ring: Ring, slot: number) => number

const pickCpu: Pick = (r, slot) => r.cpuMax[slot]
const pickRss: Pick = (r, slot) => (r.rssCount[slot] === 0 ? 0 : r.rssSum[slot] / r.rssCount[slot])
const pickProc: Pick = (r, slot) => (r.procMax ? r.procMax[slot] : 0)

function readSeries(ring: Ring, firstBucket: number, count: number, pick: Pick): DiagnosticsSeries {
  const out: DiagnosticsSeries = new Array(count)
  for (let i = 0; i < count; i++) {
    const absolute = firstBucket + i
    const slot = slotOf(absolute)
    // Retention is enforced HERE, on read: a slot still holding an older absolute index
    // simply does not match, so nothing has to expire it in the background.
    out[i] = ring.bucketIndex[slot] === absolute ? pick(ring, slot) : null
  }
  return out
}

export type HistoryRecordInput = {
  /** Wall clock of the sample, from the SERVICE's clock — the same one read() is given,
   *  so record and read can never disagree about which bucket "now" is. */
  atMs: number
  cpuPercent: number
  rssBytes: number
  processCount: number
}

export class DiagnosticsHistoryRing {
  private readonly totals = makeRing(true)
  /** Highest absolute bucket anything has been recorded into; EMPTY before the first. */
  protected lastRecordedBucket = EMPTY

  record(input: HistoryRecordInput): void {
    const absolute = Math.floor(input.atMs / BUCKET_MS)
    fold(this.totals, absolute, input.cpuPercent, input.rssBytes, input.processCount)
    if (absolute > this.lastRecordedBucket) this.lastRecordedBucket = absolute
  }

  read(nowMs: number, windowMs: number): DiagnosticsHistory {
    // windowMs arrives over IPC. A non-finite value would reach `new Array(NaN)` below.
    const requested = Number.isFinite(windowMs) ? windowMs : BUCKET_MS
    const clamped = Math.min(Math.max(requested, BUCKET_MS), RETENTION_MS)
    const bucketCount = Math.ceil(clamped / BUCKET_MS)
    const lastBucket = Math.floor(nowMs / BUCKET_MS)
    const firstBucket = lastBucket - bucketCount + 1
    return {
      bucketMs: BUCKET_MS,
      from: firstBucket * BUCKET_MS,
      bucketCount,
      total: {
        cpuPercent: readSeries(this.totals, firstBucket, bucketCount, pickCpu),
        rssBytes: readSeries(this.totals, firstBucket, bucketCount, pickRss),
        processCount: readSeries(this.totals, firstBucket, bucketCount, pickProc)
      },
      objects: []
    }
  }
}
