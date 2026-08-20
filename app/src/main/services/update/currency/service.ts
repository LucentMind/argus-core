import type { AdapterId, Candidate, CurrencyPayload } from '../../../../shared/currency'
import { blockedOf } from '../../../../shared/currency'
import type { CurrencyAnchorStore } from './anchors'
import type { CurrencyAdapter } from './adapter'

/** 6 hours. */
export const DEFAULT_INTERVAL_MS = 21_600_000
const DEFAULT_TICK_MS = 60_000

export interface CurrencyServiceDeps {
  adapters: CurrencyAdapter[]
  anchors: CurrencyAnchorStore
  /** Read live on every tick, never captured: the user can flip the switch at any moment. */
  autoEnabled: () => boolean
  /** False while anything is running. Gates DISK WRITES only — never the network. */
  isQuiet: () => boolean
  now?: () => number
  tickMs?: number
  intervalMs?: number
}

/**
 * Keeps every updatable thing current, by POLLING the wall clock rather than arming a timer for
 * each next survey.
 *
 * A `setTimeout` armed for an exact instant breaks three ways that all happen on a laptop —
 * system suspend, a DST shift, and the user changing the clock — and each needs its own detection
 * and re-arm path. A poll has one path and self-heals from all of them, because it only ever asks
 * "is the next survey in the past". The price is up to one tick of lateness on a schedule measured
 * in hours.
 *
 * CATCH-UP IS THE SAME CODE AS ORDINARY SURVEYING. After a three-day shutdown an adapter's anchor
 * is three days old and therefore due on the first tick — and because due-ness is computed from
 * the anchor rather than by enumerating missed occurrences, that produces ONE survey, not twelve.
 */
export class CurrencyService {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly listeners = new Set<(p: CurrencyPayload) => void>()
  private blocked: Candidate[] = []
  private busy = false
  private readonly intervalMs: number
  /**
   * Clean candidates awaiting a quiet moment. DERIVED, NEVER PERSISTED: if the app quits with
   * three unapplied, the next boot's survey finds them again. Persisting it would create a second
   * representation of "what needs applying" that could disagree with the world.
   */
  private pending: Candidate[] = []
  /** Serializes every write, auto and manual alike. */
  private lock: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: CurrencyServiceDeps) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  payload(): CurrencyPayload {
    const at = this.deps.anchors.lastSurveyAt()
    return {
      auto: this.deps.autoEnabled(),
      lastSurveyAt: at === null ? null : new Date(at).toISOString(),
      blocked: this.blocked,
      busy: this.busy
    }
  }

  subscribe(cb: (p: CurrencyPayload) => void): () => void {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  private publish(): void {
    const p = this.payload()
    for (const cb of this.listeners) cb(p)
  }

  /** Ticks immediately (this is the catch-up pass), then every `tickMs`. Idempotent. */
  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? DEFAULT_TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (!this.deps.autoEnabled()) return
    const now = this.now()
    for (const adapter of this.deps.adapters) {
      if (this.deps.anchors.dueAt(adapter.id, this.intervalMs) > now) continue
      const found = await this.surveyAdapter(adapter)
      this.pending.push(...found.filter((c) => c.verdict === 'clean'))
    }
    await this.applyPending()
  }

  private async surveyAdapter(adapter: CurrencyAdapter): Promise<Candidate[]> {
    this.busy = true
    this.publish()
    try {
      const found = await adapter.survey()
      // Anchor first, before anything acts on the result: a value adopted in memory before it
      // reaches disk leaves the two disagreeing after a crash.
      this.deps.anchors.recordSuccess(adapter.id, this.now())
      this.replaceBlockedFor(adapter, found)
      return found
    } catch {
      // Transport failures are silent by design — an offline week must produce no badge at all.
      this.deps.anchors.recordFailure(adapter.id, this.now())
      return []
    } finally {
      this.busy = false
      this.publish()
    }
  }

  /** The blocked list is per-survey truth: this adapter's old entries go, its new ones land. */
  private replaceBlockedFor(adapter: CurrencyAdapter, found: Candidate[]): void {
    const mine = new Set(this.blocked.filter((c) => this.ownerOf(c) === adapter.id))
    this.blocked = [...this.blocked.filter((c) => !mine.has(c)), ...blockedOf(found)]
  }

  /**
   * Writes every pending candidate, one at a time, re-checking quiescence BETWEEN items — a run
   * that starts mid-batch stops it where it is and the remainder waits for the next quiet tick.
   *
   * Serial rather than parallel because hive installs share one clone directory and pack installs
   * share the packs directory; two at once would race on the same paths.
   */
  private async applyPending(): Promise<void> {
    if (this.pending.length === 0) return
    await this.withApplyLock(async () => {
      while (this.pending.length > 0 && this.deps.isQuiet()) {
        const candidate = this.pending.shift() as Candidate
        const adapter = this.deps.adapters.find((a) => a.id === this.ownerOf(candidate))
        if (!adapter) continue
        this.busy = true
        this.publish()
        try {
          const outcome = await adapter.apply(candidate)
          // A refusal at apply time is the adapter re-deriving and finding the world moved —
          // it becomes a decision for the user, not a write to retry next tick.
          if (!outcome.ok && outcome.reason)
            this.blocked = [
              ...this.blocked,
              { ...candidate, verdict: 'blocked', reason: outcome.reason }
            ]
        } catch {
          // A write that threw is a transport/disk failure, not a decision: stay silent and let
          // the next survey re-offer it.
        } finally {
          this.busy = false
          this.publish()
        }
      }
    })
  }

  /**
   * Runs `fn` with the single global apply lock held. The manual Update handlers in `index.ts`
   * wrap themselves in this, so an auto-apply and a button press can never interleave in either
   * direction.
   */
  withApplyLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    // Swallow here only — the caller still sees the rejection through `run`.
    this.lock = run.catch(() => {})
    return run
  }

  private ownerOf(c: Candidate): AdapterId {
    return c.domain === 'core' ? 'core' : c.domain === 'pack' ? 'packs' : 'hive'
  }
}
