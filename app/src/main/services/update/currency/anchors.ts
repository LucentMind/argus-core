import type { AdapterId } from '../../../../shared/currency'

export interface CurrencyAnchor {
  /**
   * Epoch ms of the last survey ATTEMPT — success or failure — for this adapter. null ⇒ never
   * surveyed ⇒ due now. This is a SCHEDULING anchor, not a status: `recordFailure` advances it
   * too, otherwise a permanently unreachable feed would be retried on every single tick instead of
   * backing off. It must never be read as "last successful survey" — see `lastSuccessAt` below,
   * which is the field that actually means that.
   */
  lastSurveyAt: number | null
  consecutiveFailures: number
}

export type AnchorFile = Partial<Record<AdapterId, CurrencyAnchor>> & {
  /**
   * Epoch ms of the most recent survey that actually SUCCEEDED, across every adapter. Kept apart
   * from each adapter's `lastSurveyAt` (which advances on failure too) so the "Checked N minutes
   * ago" status line can be honest: during an offline week it must not read as freshly checked.
   */
  lastSuccessAt?: number
  /** Whether the first-run mirror notice has been shown. Lives here because `currency.json` is
   *  already this service's own state file; it is NOT a per-item decision. */
  firstMirrorNoticeShown?: boolean
  /**
   * The count from the most recent `onAdopted` broadcast that has not yet been acknowledged —
   * `adoptionBroadcastGate`'s persisted half of the same latch. Kept here, not only in that
   * gate's in-memory closure, so a batch that adopts while no case is open (and so is never
   * acked — see `TopBar.tsx`) survives a process restart instead of being lost the moment the
   * process that broadcast it exits. Cleared to 0 in the same write as `firstMirrorNoticeShown`,
   * never independently — see `markFirstMirrorNoticeShown` below.
   */
  pendingAdoptedCount?: number
}

/** Structural, not the JsonFileStore class — the tests need no file on disk. */
export interface AnchorFileStore {
  load(): { data: unknown; error: string | null }
  write(obj: unknown): void
}

const EMPTY: CurrencyAnchor = { lastSurveyAt: null, consecutiveFailures: 0 }
/** 6h → 12h → 24h. Two doublings, then flat: a longer ladder just means an install that was
 *  offline for a week takes another week to notice it is back. */
const MAX_DOUBLINGS = 2

function isAnchor(v: unknown): v is CurrencyAnchor {
  if (typeof v !== 'object' || v === null) return false
  const a = v as Partial<CurrencyAnchor>
  const lastOk = a.lastSurveyAt === null || typeof a.lastSurveyAt === 'number'
  return lastOk && typeof a.consecutiveFailures === 'number'
}

/**
 * Per-adapter scheduling anchors, on disk.
 *
 * Written the moment a survey settles and BEFORE anything acts on the new value. An anchor kept
 * only in memory fails twice over: a "never surveyed" default fires on every launch, and it never
 * records a next-due for the launch after that.
 *
 * Holds no opinion about what a survey does — only when the next one is allowed.
 */
export class CurrencyAnchorStore {
  constructor(private readonly store: AnchorFileStore) {}

  private file(): AnchorFile {
    const { data } = this.store.load()
    return (typeof data === 'object' && data !== null ? data : {}) as AnchorFile
  }

  get(id: AdapterId): CurrencyAnchor {
    const v = this.file()[id]
    // A hand-edited or truncated file must degrade to "never surveyed", not throw on every tick.
    return isAnchor(v) ? v : EMPTY
  }

  private set(id: AdapterId, anchor: CurrencyAnchor): void {
    this.store.write({ ...this.file(), [id]: anchor })
  }

  recordSuccess(id: AdapterId, at: number): void {
    const file = this.file()
    // `Math.max` rather than a plain overwrite: adapters settle in whatever order their surveys
    // resolve, and an earlier one finishing after a later one must not walk the value backwards.
    const lastSuccessAt = Math.max(file.lastSuccessAt ?? 0, at)
    this.store.write({ ...file, [id]: { lastSurveyAt: at, consecutiveFailures: 0 }, lastSuccessAt })
  }

  /**
   * A failed survey still moves the anchor forward — otherwise a permanently unreachable feed is
   * retried on every single tick. The failure count is what turns that into a widening gap.
   */
  recordFailure(id: AdapterId, at: number): void {
    this.set(id, {
      lastSurveyAt: at,
      consecutiveFailures: this.get(id).consecutiveFailures + 1
    })
  }

  /**
   * Epoch ms at which this adapter may be surveyed again. 0 ⇒ due now.
   *
   * The exponent is `consecutiveFailures - 1`, floored at 0, NOT `consecutiveFailures`: the gap
   * after the first failure is one plain interval (6 h), and only the second failure starts
   * doubling. That is what makes the ladder 6 → 12 → 24 rather than 12 → 24 → 24 — one flaky
   * check must not immediately double the gap.
   */
  dueAt(id: AdapterId, intervalMs: number): number {
    const { lastSurveyAt, consecutiveFailures } = this.get(id)
    if (lastSurveyAt === null) return 0
    return (
      lastSurveyAt + intervalMs * 2 ** Math.min(Math.max(0, consecutiveFailures - 1), MAX_DOUBLINGS)
    )
  }

  /**
   * Newest successful survey across every adapter, for the "Checked N minutes ago" line — reads
   * `lastSuccessAt`, NOT any adapter's `lastSurveyAt`, which also advances on a failed attempt and
   * would otherwise read as "checked" during an offline week when nothing actually succeeded.
   */
  lastSurveyAt(): number | null {
    const v = this.file().lastSuccessAt
    return typeof v === 'number' ? v : null
  }

  /** Whether the first-run mirror notice has already been shown. */
  firstMirrorNoticeShown(): boolean {
    return this.file().firstMirrorNoticeShown === true
  }

  /** Called by the renderer once it has actually shown the notice — see `CurrencyService`'s
   *  `onAdopted` for why this is never set from the broadcasting side. Clears the persisted
   *  pending count in the SAME write: once the flag is shown, the count exists to answer a
   *  question ("was anything missed?") that is now moot, and leaving it behind would replay a
   *  notice that was already acked. */
  markFirstMirrorNoticeShown(): void {
    this.store.write({ ...this.file(), firstMirrorNoticeShown: true, pendingAdoptedCount: 0 })
  }

  /** The count from the most recent unacknowledged adoption broadcast — 0 once acked. See
   *  `AnchorFile.pendingAdoptedCount`. */
  pendingAdoptedCount(): number {
    const v = this.file().pendingAdoptedCount
    return typeof v === 'number' ? v : 0
  }

  /** Called by `adoptionBroadcastGate` the moment it broadcasts, so the count survives a process
   *  restart that happens before any ack lands. */
  setPendingAdoptedCount(n: number): void {
    this.store.write({ ...this.file(), pendingAdoptedCount: n })
  }
}
