import { describe, it, expect, vi } from 'vitest'
import { createCodexDriver } from '../index'
import type { CodexClientFactory, CodexClientLike } from '../client'

interface FakeOpts {
  /** `account/read` result fields; defaults to signed-out. */
  account?: { type?: string; email?: string; planType?: string } | null
  requiresOpenaiAuth?: boolean
  /** When true, `start()` never resolves — drives the timeout path. */
  wedged?: boolean
}

function makeFake(opts: FakeOpts = {}): {
  factory: CodexClientFactory
  stop: ReturnType<typeof vi.fn>
  forceStop: ReturnType<typeof vi.fn>
  /** `env` passed to each spawned client, in call order — asserts CODEX_HOME derivation. */
  envs: NodeJS.ProcessEnv[]
} {
  const stop = vi.fn(async () => undefined)
  const forceStop = vi.fn(async () => undefined)
  const envs: NodeJS.ProcessEnv[] = []
  const factory: CodexClientFactory = (o) => {
    envs.push(o.spawn.env)
    const client: CodexClientLike = {
      start: () => (opts.wedged ? new Promise<void>(() => {}) : Promise.resolve()),
      request: async (method) => {
        if (method === 'initialize') return { userAgent: 'codex-cli/0.1' }
        if (method === 'account/read') {
          return {
            account: opts.account ?? null,
            requiresOpenaiAuth: opts.requiresOpenaiAuth ?? true
          }
        }
        return {}
      },
      notify: () => {},
      onNotification: () => {},
      onServerRequest: () => {},
      stop,
      forceStop
    }
    return client
  }
  return { factory, stop, forceStop, envs }
}

describe('createCodexDriver — runHeadless wiring', () => {
  it('exposes runHeadless and flips capabilities.headlessOneShot to true', () => {
    const driver = createCodexDriver()
    expect(typeof driver.runHeadless).toBe('function')
    expect(driver.capabilities.headlessOneShot).toBe(true)
  })
})

describe('createCodexDriver — probeAuth', () => {
  it('reports not-ok with a `codex login` hint when signed out, and reaps the client', async () => {
    const { factory, stop } = makeFake({ account: null, requiresOpenaiAuth: true })
    const res = await createCodexDriver({}, { clientFactory: factory }).probeAuth({})
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('codex login')
    expect(stop).toHaveBeenCalled()
  })

  it('reports not-ok when account is present but requiresOpenaiAuth is true', async () => {
    const { factory } = makeFake({
      account: { type: 'chatgpt', email: 'x@y.z' },
      requiresOpenaiAuth: true
    })
    const res = await createCodexDriver({}, { clientFactory: factory }).probeAuth({})
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('codex login')
  })

  it('reports ok with account identity when authenticated', async () => {
    const { factory } = makeFake({
      account: { type: 'chatgpt', email: 'x@y.z', planType: 'plus' },
      requiresOpenaiAuth: false
    })
    const res = await createCodexDriver({}, { clientFactory: factory }).probeAuth({})
    expect(res.ok).toBe(true)
    expect(res.email).toBe('x@y.z')
    expect(res.subscription).toBe('plus')
  })

  it('bounds a wedged start(): resolves not-ok within timeoutMs and still reaps the client', async () => {
    const { factory, stop, forceStop } = makeFake({ wedged: true })
    const started = Date.now()
    const res = await createCodexDriver({}, { clientFactory: factory }).probeAuth({
      timeoutMs: 30
    })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('30ms')
    expect(stop.mock.calls.length + forceStop.mock.calls.length).toBeGreaterThan(0)
  })

  // CARRYOVER regression (Task 6→8): the probe's CODEX_HOME must NOT be hardcoded to a
  // scratch dir (os.tmpdir()) — codex auth.json is CODEX_HOME-scoped, so a scratch home
  // always reads as signed-out even when the real instance is authenticated. argusHome is
  // not reachable on the probeAuth path (its config is `{cliPath?, timeoutMs?}`, and
  // createCodexDriver's own config/deps carry no argusHome either — driverRegistry.ts
  // constructs each driver once at startup with neither), so the only thing the probe CAN
  // honor is a per-instance codexHome override; absent that, CODEX_HOME must stay whatever
  // the process already has (i.e. the driver forces nothing), never a tmpdir path.
  describe('CODEX_HOME derivation (carryover fix)', () => {
    it('honors a configured codexHome override', async () => {
      const { factory, envs } = makeFake({ account: null, requiresOpenaiAuth: true })
      await createCodexDriver({ codexHome: 'C:/argus-home/codex-home' } as never, {
        clientFactory: factory
      }).probeAuth({})
      expect(envs[0].CODEX_HOME).toBe('C:/argus-home/codex-home')
    })

    it('does not force CODEX_HOME to os.tmpdir() when no override is configured', async () => {
      const { factory, envs } = makeFake({ account: null, requiresOpenaiAuth: true })
      await createCodexDriver({}, { clientFactory: factory }).probeAuth({})
      // Left exactly as inherited from process.env — never a driver-invented scratch path.
      expect(envs[0].CODEX_HOME).toBe(process.env.CODEX_HOME)
    })
  })
})
