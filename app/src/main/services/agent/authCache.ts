import type { AuthStatus } from '../../../shared/types'

/**
 * The auth verdict, derived at the point of use (spec §5).
 *
 * Success used to be cached forever and invalidated only by a settings change, so one
 * boot probe painted `claude ✓` for the whole app lifetime while every turn 401'd. The
 * cache now yields to turn evidence: a real turn is the only thing that authenticates.
 */
export class AuthCache {
  private cached: AuthStatus | null = null
  // Bumped by every path that deliberately drops the cache (onAuthFailure, invalidate).
  // A get() that started probing before the bump is answering a question that's no longer
  // being asked — turn evidence outranks a probe that was already in flight, so its result
  // is still handed back to its own caller but must not overwrite what came after it.
  private generation = 0
  /** Evidence from a real turn. Outranks the probe in BOTH directions: the probe runs with
   *  maxTurns:0 and never contacts the API, so it reports ok:true even when logged out.
   *  Cleared only by newer evidence (a verified turn), an explicit re-probe, or a settings change. */
  private turnVerdict: 'failed' | 'verified' | null = null

  constructor(
    private probe: () => Promise<AuthStatus>,
    private notify: () => void
  ) {}

  async get(force = false): Promise<AuthStatus> {
    if (force) {
      this.cached = null
      this.turnVerdict = null
      this.generation++
    }
    if (this.turnVerdict === 'failed') {
      return {
        ok: false,
        verified: false,
        detail: 'Claude rejected the last message — sign in with /login, then send again'
      }
    }
    const withVerdict = (s: AuthStatus): AuthStatus =>
      this.turnVerdict === 'verified' && s.ok ? { ...s, verified: true } : s
    if (this.cached) return withVerdict(this.cached)
    const generation = this.generation
    const status = await this.probe()
    // only cache success — a failed probe should retry on the next case open
    if (status.ok && generation === this.generation) this.cached = status
    return withVerdict(status)
  }

  /** A turn failed auth-shaped: the probe cannot see this, so record it. Always notifies. */
  onAuthFailure(): void {
    this.cached = null
    this.turnVerdict = 'failed'
    this.generation++
    this.notify()
  }

  /** A turn completed normally — the only real proof the credentials work. Idempotent. */
  onAuthVerified(): void {
    if (this.turnVerdict === 'verified') return
    this.turnVerdict = 'verified'
    this.notify()
  }

  /** Settings changed — the probe target may differ. Clears without notifying. */
  invalidate(): void {
    this.cached = null
    this.turnVerdict = null
    this.generation++
  }
}
