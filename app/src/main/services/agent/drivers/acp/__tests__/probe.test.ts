import { describe, it, expect, vi } from 'vitest'
import { createAcpDriver } from '../index'
import type { AcpClientFactory, AcpClientLike } from '../client'
import { CURSOR_PROFILE } from '../profiles/cursor'
import { GROK_PROFILE } from '../profiles/grok'

/**
 * Task 10: hardens the Task 6 minimal `probeAuth` (env-var presence only) into a bounded live
 * ACP handshake — `client.start()` (the `initialize` round trip) raced against `timeoutMs`,
 * torn down in `finally`. DI-testable without a real `cursor-agent`/`grok` binary: the
 * `clientFactory` seam (same one `createSession` uses) is scripted per case, so these tests
 * exercise the driver's race/teardown/error-classification logic directly.
 */

/** A scripted `AcpClientFactory` whose `start()` behavior is supplied per test; `newSession`/
 *  `loadSession` are never called from `probeAuth` (only `start`+`stop`) and throw if they are. */
function makeClientFactory(start: () => Promise<void>): {
  factory: AcpClientFactory
  stop: ReturnType<typeof vi.fn>
} {
  const stop = vi.fn(async () => undefined)
  const factory: AcpClientFactory = () => {
    const client: AcpClientLike = {
      start,
      async newSession() {
        throw new Error('probeAuth must not call newSession')
      },
      async loadSession() {
        throw new Error('probeAuth must not call loadSession')
      },
      stop
    }
    return client
  }
  return { factory, stop }
}

describe('createAcpDriver — probeAuth (bounded handshake)', () => {
  it('resolves ok:false with the login hint when the auth env var is absent, without spawning', async () => {
    const prior = process.env.CURSOR_API_KEY
    delete process.env.CURSOR_API_KEY
    const factory = vi.fn<AcpClientFactory>(() => {
      throw new Error('clientFactory must not be called when the env var is absent')
    })
    try {
      const driver = createAcpDriver(CURSOR_PROFILE, { clientFactory: factory })
      const res = await driver.probeAuth({})
      expect(res.ok).toBe(false)
      expect(res.detail).toBe(CURSOR_PROFILE.auth.loginHint)
      expect(factory).not.toHaveBeenCalled()
    } finally {
      if (prior !== undefined) process.env.CURSOR_API_KEY = prior
    }
  })

  it('resolves ok:true when the handshake completes, and tears the client down', async () => {
    const prior = process.env.CURSOR_API_KEY
    process.env.CURSOR_API_KEY = 'sk-test'
    const { factory, stop } = makeClientFactory(async () => undefined)
    try {
      const driver = createAcpDriver(CURSOR_PROFILE, { clientFactory: factory })
      const res = await driver.probeAuth({})
      expect(res.ok).toBe(true)
      expect(res.detail).toContain('Cursor')
      expect(stop).toHaveBeenCalledTimes(1)
    } finally {
      if (prior === undefined) delete process.env.CURSOR_API_KEY
      else process.env.CURSOR_API_KEY = prior
    }
  })

  it('bounds a hung handshake by timeoutMs and still tears the client down', async () => {
    const prior = process.env.CURSOR_API_KEY
    process.env.CURSOR_API_KEY = 'sk-test'
    const { factory, stop } = makeClientFactory(() => new Promise<void>(() => {}))
    try {
      const driver = createAcpDriver(CURSOR_PROFILE, { clientFactory: factory })
      const started = Date.now()
      const res = await driver.probeAuth({ timeoutMs: 30 })
      expect(Date.now() - started).toBeLessThan(2000) // bounded, not the 10s default
      expect(res.ok).toBe(false)
      expect(stop).toHaveBeenCalledTimes(1)
    } finally {
      if (prior === undefined) delete process.env.CURSOR_API_KEY
      else process.env.CURSOR_API_KEY = prior
    }
  })

  it('resolves ok:false with a spawn-shaped detail when the handshake rejects with ENOENT, and tears down', async () => {
    const prior = process.env.CURSOR_API_KEY
    process.env.CURSOR_API_KEY = 'sk-test'
    const enoent = Object.assign(new Error('spawn cursor-agent ENOENT'), { code: 'ENOENT' })
    const { factory, stop } = makeClientFactory(async () => {
      throw enoent
    })
    try {
      const driver = createAcpDriver(CURSOR_PROFILE, { clientFactory: factory })
      const res = await driver.probeAuth({})
      expect(res.ok).toBe(false)
      expect(res.detail).toMatch(/not found/i)
      expect(stop).toHaveBeenCalledTimes(1)
    } finally {
      if (prior === undefined) delete process.env.CURSOR_API_KEY
      else process.env.CURSOR_API_KEY = prior
    }
  })

  it('a non-spawn-shaped rejection falls back to the login hint', async () => {
    const prior = process.env.CURSOR_API_KEY
    process.env.CURSOR_API_KEY = 'sk-test'
    const { factory, stop } = makeClientFactory(async () => {
      throw new Error('Unauthorized: invalid API key')
    })
    try {
      const driver = createAcpDriver(CURSOR_PROFILE, { clientFactory: factory })
      const res = await driver.probeAuth({})
      expect(res.ok).toBe(false)
      expect(res.detail).toBe(CURSOR_PROFILE.auth.loginHint)
      expect(stop).toHaveBeenCalledTimes(1)
    } finally {
      if (prior === undefined) delete process.env.CURSOR_API_KEY
      else process.env.CURSOR_API_KEY = prior
    }
  })

  it('uses the profile-specific env var (Grok = XAI_API_KEY)', async () => {
    const prior = process.env.XAI_API_KEY
    delete process.env.XAI_API_KEY
    const factory = vi.fn<AcpClientFactory>(() => {
      throw new Error('clientFactory must not be called when the env var is absent')
    })
    try {
      const driver = createAcpDriver(GROK_PROFILE, { clientFactory: factory })
      const res = await driver.probeAuth({})
      expect(res.ok).toBe(false)
      expect(res.detail).toBe(GROK_PROFILE.auth.loginHint)
      expect(factory).not.toHaveBeenCalled()
    } finally {
      if (prior !== undefined) process.env.XAI_API_KEY = prior
    }
  })
})
