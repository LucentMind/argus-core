import {
  DIAGNOSTICS_BUCKET_COUNT as BUCKET_COUNT,
  DIAGNOSTICS_BUCKET_MS as BUCKET_MS,
  DIAGNOSTICS_RETENTION_MS as RETENTION_MS,
  type DiagnosticsHistory,
  type DiagnosticsSeries,
  type DiagnosticsObject,
  type DiagnosticsHistorySeries,
  type DiagnosticsObjectKind
} from '../../../shared/diagnostics'

/** Sentinel for a slot nothing has ever been written into.
 *  Must be sufficiently negative to avoid colliding with real bucket numbers,
 *  which can range from -(BUCKET_COUNT - 1) when reading windows spanning time 0. */
const EMPTY = -(BUCKET_COUNT + 1)

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

/**
 * Distinct object ids retained. Sized well above the ~10–15 rows a typical session shows,
 * so live rows are never at risk even before the LRU ordering protects them.
 */
export const OBJECT_CAP = 64

type ObjectEntry = {
  ring: Ring
  label: string
  kind: DiagnosticsObjectKind
  inferred: boolean
  lastSeenBucket: number
}

export type HistoryRecordInput = {
  /** Wall clock of the sample, from the SERVICE's clock — the same one read() is given,
   *  so record and read can never disagree about which bucket "now" is. */
  atMs: number
  cpuPercent: number
  rssBytes: number
  processCount: number
  objects: DiagnosticsObject[]
}

export class DiagnosticsHistoryRing {
  private readonly totals = makeRing(true)
  /** Highest absolute bucket anything has been recorded into; EMPTY before the first. */
  private lastRecordedBucket = EMPTY
  private readonly objects = new Map<string, ObjectEntry>()

  record(input: HistoryRecordInput): void {
    const absolute = Math.floor(input.atMs / BUCKET_MS)
    fold(this.totals, absolute, input.cpuPercent, input.rssBytes, input.processCount)
    if (absolute > this.lastRecordedBucket) this.lastRecordedBucket = absolute

    for (const o of input.objects) {
      let entry = this.objects.get(o.id)
      if (!entry) {
        entry = {
          ring: makeRing(),
          label: o.label,
          kind: o.kind,
          inferred: o.inferred,
          lastSeenBucket: absolute
        }
        this.objects.set(o.id, entry)
      }
      // Refresh the identity every time: a panel's title and a row's inferred flag can
      // both change over the life of one process, and the latest is the true one.
      entry.label = o.label
      entry.kind = o.kind
      entry.inferred = o.inferred
      if (absolute > entry.lastSeenBucket) entry.lastSeenBucket = absolute
      fold(entry.ring, absolute, o.cpuPercent, o.rssBytes)
    }
    this.evict()
  }

  /**
   * LRU by last-seen, and the ORDERING is load-bearing rather than incidental.
   *
   * A crash-looping process mints a fresh `pid:startTimeMs` id on every respawn — exactly
   * the churn signal this page exists to surface — so a cap that evicted arbitrarily
   * would discard the history of rows that are still running. A live row is by definition
   * among the most recently seen, so smallest-lastSeenBucket-first always discards dead
   * history before live.
   *
   * A linear scan, not a heap: the map holds at most OBJECT_CAP + the rows of one sample,
   * and an obviously-correct O(n) loop beats a clever structure at this size. Strict `<`
   * keeps the FIRST-inserted entry as the victim on a tie, which makes eviction
   * deterministic for tests.
   */
  private evict(): void {
    while (this.objects.size > OBJECT_CAP) {
      let victim: string | null = null
      let oldest = Number.POSITIVE_INFINITY
      for (const [id, entry] of this.objects) {
        if (entry.lastSeenBucket < oldest) {
          oldest = entry.lastSeenBucket
          victim = id
        }
      }
      if (victim === null) return
      this.objects.delete(victim)
    }
  }

  read(nowMs: number, windowMs: number): DiagnosticsHistory {
    // windowMs arrives over IPC. A non-finite value would reach `new Array(NaN)` below.
    const requested = Number.isFinite(windowMs) ? windowMs : BUCKET_MS
    const clamped = Math.min(Math.max(requested, BUCKET_MS), RETENTION_MS)
    const bucketCount = Math.ceil(clamped / BUCKET_MS)
    const lastBucket = Math.floor(nowMs / BUCKET_MS)
    const firstBucket = lastBucket - bucketCount + 1

    const objects: DiagnosticsHistorySeries[] = []
    for (const [id, entry] of this.objects) {
      const cpuPercent = readSeries(entry.ring, firstBucket, bucketCount, pickCpu)
      // Omit an object with nothing inside the requested window rather than shipping a
      // full-length run of nulls describing a period the caller did not ask about.
      if (!cpuPercent.some((v) => v !== null)) continue
      objects.push({
        id,
        label: entry.label,
        kind: entry.kind,
        inferred: entry.inferred,
        // Derived from recorded data rather than passed in, so liveness can never become
        // a second source of truth that disagrees with the ring itself.
        live: entry.lastSeenBucket === this.lastRecordedBucket,
        cpuPercent,
        rssBytes: readSeries(entry.ring, firstBucket, bucketCount, pickRss)
      })
    }

    return {
      bucketMs: BUCKET_MS,
      from: firstBucket * BUCKET_MS,
      bucketCount,
      total: {
        cpuPercent: readSeries(this.totals, firstBucket, bucketCount, pickCpu),
        rssBytes: readSeries(this.totals, firstBucket, bucketCount, pickRss),
        processCount: readSeries(this.totals, firstBucket, bucketCount, pickProc)
      },
      objects
    }
  }
}
