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

  constructor(
    private probe: () => Promise<AuthStatus>,
    private notify: () => void
  ) {}

  async get(force = false): Promise<AuthStatus> {
    if (force) this.cached = null
    if (this.cached) return this.cached
    const generation = this.generation
    const status = await this.probe()
    // only cache success — a failed probe should retry on the next case open
    if (status.ok && generation === this.generation) this.cached = status
    return status
  }

  /** A turn failed auth-shaped: the cached verdict is now known-wrong. */
  onAuthFailure(): void {
    this.cached = null
    this.generation++
    this.notify()
  }

  /** A turn completed normally: the credentials are proven. Idempotent. */
  onAuthVerified(): void {
    if (!this.cached || this.cached.verified) return
    this.cached = { ...this.cached, verified: true }
    this.notify()
  }

  /** Settings changed — the probe target may differ. */
  invalidate(): void {
    this.cached = null
    this.generation++
  }
}
