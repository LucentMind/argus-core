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

  constructor(
    private probe: () => Promise<AuthStatus>,
    private notify: () => void
  ) {}

  async get(force = false): Promise<AuthStatus> {
    if (force) this.cached = null
    if (this.cached) return this.cached
    const status = await this.probe()
    // only cache success — a failed probe should retry on the next case open
    if (status.ok) this.cached = status
    return status
  }

  /** A turn failed auth-shaped: the cached verdict is now known-wrong. */
  onAuthFailure(): void {
    this.cached = null
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
  }
}
