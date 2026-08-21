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
  /** Called once per apply batch with the number of BRAND-NEW adoptions (`from === null`) that
   *  actually landed. Not called when the count is zero, and never for an update to something
   *  already installed — the first-run notice is about the mirror adopting things you never
   *  asked for, which is the surprising part. */
  onAdopted?: (count: number) => void
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
  /**
   * Consecutive surveys in which an adapter reported an `auth` block. An expired `gh` sign-in is
   * a decision only the user can act on, but it presents exactly like a flaky network — so it is
   * shown on the SECOND consecutive sighting, not the first.
   */
  private authStrikes = new Map<AdapterId, number>()
  /**
   * Same idea as `authStrikes`, but for a refusal seen at APPLY time rather than survey time —
   * kept in a separate map because a survey that comes back clean (the normal case right before an
   * apply-time `auth` refusal: the check succeeded, the write failed) resets `authStrikes` to 0 on
   * every tick, which would silently defeat the two-strike grace for this path if it shared the
   * counter.
   */
  private applyAuthStrikes = new Map<AdapterId, number>()

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

  /**
   * Drops any blocked entry matching `key` and republishes.
   *
   * `this.blocked` is otherwise rewritten only by `replaceBlockedFor`, which runs on a SURVEY —
   * and the manual apply/install IPC handlers in `index.ts` never trigger one. Without this, a
   * hold a user has just resolved by hand (e.g. Update -> Overwrite my copy on a `local-edits`
   * block) keeps reading as held back — the badge, the nav dot, the reason line, all of it — with
   * no user-accessible way to clear it until the next scheduled survey, up to 6h later. Called
   * from those handlers right after a successful outcome; a key that is not currently held back is
   * a harmless no-op.
   */
  forget(key: string): void {
    this.blocked = this.blocked.filter((c) => c.key !== key)
    this.publish()
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

  /**
   * Survey one adapter on demand — what the Packs and HiveMind Settings tabs call on mount.
   *
   * Runs with auto mode OFF: the switch governs APPLYING and the poll, not checking, so visiting
   * those tabs refreshes their status exactly as it did before this service existed. Rate-limited
   * to the same interval, so re-entering a tab five times in a minute costs one network round.
   */
  async surveyNow(id: AdapterId): Promise<void> {
    const adapter = this.deps.adapters.find((a) => a.id === id)
    if (!adapter) return
    if (this.deps.anchors.dueAt(id, this.intervalMs) > this.now()) return
    const found = await this.surveyAdapter(adapter)
    if (!this.deps.autoEnabled()) return
    this.pushPending(found)
    await this.applyPending()
  }

  private async tick(): Promise<void> {
    if (!this.deps.autoEnabled()) return
    const now = this.now()
    for (const adapter of this.deps.adapters) {
      if (this.deps.anchors.dueAt(adapter.id, this.intervalMs) > now) continue
      const found = await this.surveyAdapter(adapter)
      this.pushPending(found)
    }
    await this.applyPending()
  }

  /**
   * Queues every clean candidate from a survey, deduped by `key`: a later survey's version of a
   * candidate REPLACES an earlier queued one in place rather than sitting beside it, because the
   * newer survey is the more current truth. Without this, a machine that is rarely quiet piles up
   * repeat copies of the same candidate at every 6h survey, and the eventual drain applies (and,
   * on refusal, blocks) each one several times over.
   */
  private pushPending(found: Candidate[]): void {
    for (const c of found) {
      if (c.verdict !== 'clean') continue
      const idx = this.pending.findIndex((p) => p.key === c.key)
      if (idx === -1) this.pending.push(c)
      else this.pending[idx] = c
    }
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
    const fresh = blockedOf(found)
    const hasAuth = fresh.some((c) => c.reason?.kind === 'auth')
    const strikes = hasAuth ? (this.authStrikes.get(adapter.id) ?? 0) + 1 : 0
    this.authStrikes.set(adapter.id, strikes)
    // First sighting of an auth failure is withheld; a second consecutive one is real.
    const shown = strikes === 1 ? fresh.filter((c) => c.reason?.kind !== 'auth') : fresh
    this.blocked = [...this.blocked.filter((c) => this.ownerOf(c) !== adapter.id), ...shown]
  }

  /**
   * Writes every pending candidate.
   *
   * Core is drained UNCONDITIONALLY, first: it writes only into electron-updater's cache —
   * nothing the running app reads — so a long agent turn or a busy ingest queue must never starve
   * it. Pack and hive candidates write files the app may be reading, so they wait their turn,
   * re-checking quiescence BETWEEN items — a run that starts mid-batch stops it where it is and
   * the remainder waits for the next quiet tick.
   *
   * Serial rather than parallel because hive installs share one clone directory and pack installs
   * share the packs directory; two at once would race on the same paths.
   */
  private async applyPending(): Promise<void> {
    if (this.pending.length === 0) return
    await this.withApplyLock(async () => {
      let adopted = 0
      for (;;) {
        const idx = this.pending.findIndex((c) => c.domain === 'core')
        if (idx === -1) break
        const [candidate] = this.pending.splice(idx, 1)
        if (await this.applyOne(candidate)) adopted++
      }
      while (this.pending.length > 0 && this.deps.isQuiet()) {
        const candidate = this.pending.shift() as Candidate
        if (await this.applyOne(candidate)) adopted++
      }
      // Fired once per batch, still inside the lock — `onAdopted` is a plain synchronous
      // notification, not a write the lock needs to order against anything else, but reporting
      // it here keeps "the batch, including its count" one atomic unit from the caller's view,
      // and costs nothing since the lock is about to release either way. Never fired at zero:
      // the first-run notice is about SURPRISE, and a batch with no brand-new adoption is not.
      if (adopted > 0) this.deps.onAdopted?.(adopted)
    })
  }

  /**
   * Applies one candidate. Returns true iff it was a BRAND-NEW adoption (`from === null`) that
   * actually landed — the only shape `applyPending`'s `onAdopted` count includes. An update to
   * something already installed, or an apply that refused or threw, returns false.
   */
  private async applyOne(candidate: Candidate): Promise<boolean> {
    const adapter = this.deps.adapters.find((a) => a.id === this.ownerOf(candidate))
    if (!adapter) return false
    this.busy = true
    this.publish()
    try {
      const outcome = await adapter.apply(candidate)
      if (outcome.ok) {
        // A write that actually succeeded ends any run of apply-time auth flakiness for this
        // adapter — the next refusal, if any, is a fresh first strike.
        this.applyAuthStrikes.delete(adapter.id)
        return candidate.from === null
      } else if (outcome.reason) {
        // A refusal at apply time is the adapter re-deriving and finding the world moved — it
        // becomes a decision for the user, not a write to retry next tick. An `auth` refusal is
        // the one exception: it presents exactly like a flaky `gh` sign-in, so it goes through the
        // same two-strike grace as a survey-time one instead of badging the user on its first
        // sighting.
        const show = outcome.reason.kind !== 'auth' || this.noteApplyAuthStrike(adapter.id)
        if (show)
          this.blocked = [
            ...this.blocked,
            { ...candidate, verdict: 'blocked', reason: outcome.reason }
          ]
      }
      // No `reason` ⇒ a transport failure, not a decision: dropped silently here, exactly as
      // the `catch` below does, and re-offered by the next survey.
      return false
    } catch {
      // A write that threw is a transport/disk failure, not a decision: stay silent and let the
      // next survey re-offer it.
      return false
    } finally {
      this.busy = false
      this.publish()
    }
  }

  /** Same two-strike grace as `replaceBlockedFor`, applied to an apply-time `auth` refusal. */
  private noteApplyAuthStrike(id: AdapterId): boolean {
    const strikes = (this.applyAuthStrikes.get(id) ?? 0) + 1
    this.applyAuthStrikes.set(id, strikes)
    return strikes >= 2
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
