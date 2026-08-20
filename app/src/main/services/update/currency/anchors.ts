import type { AdapterId } from '../../../../shared/currency'

export interface CurrencyAnchor {
  /** Epoch ms of the last SUCCESSFUL survey. null ⇒ never surveyed ⇒ due now. */
  lastSurveyAt: number | null
  consecutiveFailures: number
}

export type AnchorFile = Partial<Record<AdapterId, CurrencyAnchor>>

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
    this.set(id, { lastSurveyAt: at, consecutiveFailures: 0 })
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

  /** Epoch ms at which this adapter may be surveyed again. 0 ⇒ due now. */
  dueAt(id: AdapterId, intervalMs: number): number {
    const { lastSurveyAt, consecutiveFailures } = this.get(id)
    if (lastSurveyAt === null) return 0
    return lastSurveyAt + intervalMs * 2 ** Math.min(Math.max(0, consecutiveFailures - 1), MAX_DOUBLINGS)
  }

  /** Newest successful survey across every adapter, for the "Checked N minutes ago" line. */
  lastSurveyAt(): number | null {
    const times = (['core', 'packs', 'hive'] as const)
      .map((id) => this.get(id).lastSurveyAt)
      .filter((t): t is number => t !== null)
    return times.length > 0 ? Math.max(...times) : null
  }
}
