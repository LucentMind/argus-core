import { describe, it, expect, vi } from 'vitest'
import { AuthCache } from '../authCache'
import type { AuthStatus } from '../../../../shared/types'

const ok = (verified: boolean): AuthStatus => ({ ok: true, verified, detail: 'claude ready' })

/** A promise plus its resolver, for controlling exactly when an in-flight probe settles. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

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

  it('an auth failure drops the cache and notifies', async () => {
    const probe = vi.fn<() => Promise<AuthStatus>>().mockResolvedValue(ok(true))
    const notify = vi.fn()
    const c = new AuthCache(probe, notify)
    await c.get()
    c.onAuthFailure()
    expect(notify).toHaveBeenCalledTimes(1)
    // the next get() reports the failure verdict directly — it does not resurrect the
    // dropped cache by re-probing (the probe would say ok:true; see the dedicated test below)
    const status = await c.get()
    expect(status.ok).toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('after onAuthFailure(), get() returns ok:false without calling the probe at all', async () => {
    const probe = vi.fn<() => Promise<AuthStatus>>().mockResolvedValue(ok(true))
    const c = new AuthCache(probe, () => {})
    await c.get()
    expect(probe).toHaveBeenCalledTimes(1)
    c.onAuthFailure()
    const status = await c.get()
    expect(status.ok).toBe(false)
    expect(status.verified).toBe(false)
    // the whole point: the maxTurns:0 probe never contacts the API, so it cannot see
    // a turn failure — get() must not ask it again to find that out
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('onAuthVerified() after onAuthFailure() clears the failed verdict, so a later get() probes again', async () => {
    const probe = vi.fn<() => Promise<AuthStatus>>().mockResolvedValue(ok(false))
    const c = new AuthCache(probe, () => {})
    await c.get()
    expect(probe).toHaveBeenCalledTimes(1)
    c.onAuthFailure()
    expect((await c.get()).ok).toBe(false)
    expect(probe).toHaveBeenCalledTimes(1) // still hasn't re-probed

    c.onAuthVerified()
    const status = await c.get()
    expect(status).toEqual({ ok: true, verified: true, detail: 'claude ready' })
    expect(probe).toHaveBeenCalledTimes(2) // the failed verdict was cleared, so it probed again
  })

  it('get(true) (force) clears a failed verdict and re-probes', async () => {
    const probe = vi.fn<() => Promise<AuthStatus>>().mockResolvedValue(ok(true))
    const c = new AuthCache(probe, () => {})
    await c.get()
    c.onAuthFailure()
    expect((await c.get()).ok).toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)

    const status = await c.get(true)
    expect(status.ok).toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('invalidate() clears a failed verdict', async () => {
    const probe = vi.fn<() => Promise<AuthStatus>>().mockResolvedValue(ok(true))
    const c = new AuthCache(probe, () => {})
    await c.get()
    c.onAuthFailure()
    expect((await c.get()).ok).toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)

    c.invalidate()
    const status = await c.get()
    expect(status.ok).toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('a verified turn while a probe is in flight upgrades the in-flight result to verified:true', async () => {
    const inFlight = deferred<AuthStatus>()
    const probe = vi.fn<() => Promise<AuthStatus>>().mockReturnValueOnce(inFlight.promise)
    const c = new AuthCache(probe, () => {})

    const getPromise = c.get() // probe in flight, still unsettled...
    c.onAuthVerified() // ...a turn completes normally while it's still running...
    inFlight.resolve(ok(false)) // ...then the probe resolves ok:true, verified:false

    // turn evidence outranks the probe: the caller sees verified:true even though the
    // probe itself never observed a verified session
    const status = await getPromise
    expect(status).toEqual({ ok: true, verified: true, detail: 'claude ready' })
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

  it('invalidate() clears the cache WITHOUT notifying — a settings change must not flip the chip on its own', async () => {
    const probe = vi.fn<() => Promise<AuthStatus>>().mockResolvedValue(ok(true))
    const notify = vi.fn()
    const c = new AuthCache(probe, notify)
    await c.get()
    c.invalidate()
    expect(notify).not.toHaveBeenCalled()
  })

  it('a probe in flight when onAuthFailure() fires must not resurrect the verdict turn evidence just killed', async () => {
    const inFlight = deferred<AuthStatus>()
    const probe = vi
      .fn<() => Promise<AuthStatus>>()
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValue(ok(true))
    const notify = vi.fn()
    const c = new AuthCache(probe, notify)

    const getPromise = c.get() // probe in flight...
    c.onAuthFailure() // ...a real turn 401's and clears the cache first...
    inFlight.resolve(ok(true)) // ...then the stale probe resolves success

    const staleResult = await getPromise
    expect(staleResult).toEqual(ok(true)) // the original caller still gets the probe's answer

    const next = await c.get() // but the next call must NOT see a resurrected cached success
    expect(next.ok).toBe(false) // turn evidence (the failure) wins
    expect(probe).toHaveBeenCalledTimes(1) // and it didn't even need to re-probe to know that
  })

  it('a probe in flight when invalidate() fires must not resurrect a stale verdict', async () => {
    const inFlight = deferred<AuthStatus>()
    const probe = vi
      .fn<() => Promise<AuthStatus>>()
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValue(ok(true))
    const c = new AuthCache(probe, () => {})

    const getPromise = c.get() // probe in flight...
    c.invalidate() // ...settings change drops the cache first...
    inFlight.resolve(ok(true)) // ...then the stale probe resolves success

    await getPromise

    await c.get() // must NOT see a resurrected cached success
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('a get() with no interleaved invalidation still caches its success', async () => {
    const probe = vi.fn<() => Promise<AuthStatus>>().mockResolvedValue(ok(true))
    const c = new AuthCache(probe, () => {})
    await c.get()
    await c.get()
    expect(probe).toHaveBeenCalledTimes(1) // guard against over-correcting into "never caches"
  })
})
