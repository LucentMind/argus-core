import { describe, it, expect, vi } from 'vitest'
import { AuthCache } from '../authCache'
import type { AuthStatus } from '../../../../shared/types'

const ok = (verified: boolean): AuthStatus => ({ ok: true, verified, detail: 'claude ready' })

describe('AuthCache', () => {
  it('caches only success; a failed probe re-probes every call', async () => {
    const probe = vi.fn<() => Promise<AuthStatus>>().mockResolvedValue({
      ok: false,
      verified: false,
      detail: 'nope'
    })
    const c = new AuthCache(probe, () => {})
    await c.get()
    await c.get()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('serves a cached success without re-probing', async () => {
    const probe = vi.fn<() => Promise<AuthStatus>>().mockResolvedValue(ok(false))
    const c = new AuthCache(probe, () => {})
    await c.get()
    await c.get()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('force re-probes', async () => {
    const probe = vi.fn<() => Promise<AuthStatus>>().mockResolvedValue(ok(false))
    const c = new AuthCache(probe, () => {})
    await c.get()
    await c.get(true)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('an auth failure invalidates the cache and notifies', async () => {
    const probe = vi.fn<() => Promise<AuthStatus>>().mockResolvedValue(ok(true))
    const notify = vi.fn()
    const c = new AuthCache(probe, notify)
    await c.get()
    c.onAuthFailure()
    expect(notify).toHaveBeenCalledTimes(1)
    await c.get()
    expect(probe).toHaveBeenCalledTimes(2) // cache was dropped
  })

  it('a verified turn upgrades a cached unverified success, and is idempotent', async () => {
    const probe = vi.fn<() => Promise<AuthStatus>>().mockResolvedValue(ok(false))
    const notify = vi.fn()
    const c = new AuthCache(probe, notify)
    expect((await c.get()).verified).toBe(false)
    c.onAuthVerified()
    expect((await c.get()).verified).toBe(true)
    expect(notify).toHaveBeenCalledTimes(1)
    c.onAuthVerified() // already verified — no second broadcast
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('invalidate() drops the cache (settings changed)', async () => {
    const probe = vi.fn<() => Promise<AuthStatus>>().mockResolvedValue(ok(true))
    const c = new AuthCache(probe, () => {})
    await c.get()
    c.invalidate()
    await c.get()
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
