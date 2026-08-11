import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { assertPermissionMode } from '../services/agent/sessionStore'
import { PERMISSION_MODES } from '../../shared/settings'
import { IPC } from '../../shared/ipc'

describe('assertPermissionMode', () => {
  it('accepts every real mode', () => {
    for (const m of PERMISSION_MODES) {
      expect(() => assertPermissionMode(m)).not.toThrow()
    }
  })

  it('rejects anything else, since a bad mode would strand the chat', () => {
    expect(() => assertPermissionMode('bogus')).toThrow(/permission mode/i)
    expect(() => assertPermissionMode(undefined)).toThrow(/permission mode/i)
  })
})

/**
 * `main/index.ts` imports `electron` at module scope, so it cannot be `import`ed into a Vitest
 * test — same constraint as routinesReconcileOrdering.test.ts and routinesIpc.test.ts, which
 * this follows: read it as source text and assert on the structure instead of invoking the
 * handler.
 *
 * These tests cover the `IPC.sessionsSetModel` handler's permission-mode reconciliation branch
 * (main/index.ts, added alongside reconcilePermissionModeForDriver in sessionStore.ts): before
 * this, nothing referenced `IPC.sessionsSetModel` in any test, so the `previousInstanceId !==
 * instanceId` gate and the `permissionModes` argument it passes were unexercised — a regression
 * there (e.g. reconciling on every re-pin instead of only a provider change, or passing the
 * wrong driver's capabilities) would compile clean and turn no test red.
 */
describe('IPC.sessionsSetModel reconciles permission mode on an instance change', () => {
  const indexSrc = fs.readFileSync(path.resolve(__dirname, '..', 'index.ts'), 'utf8')

  it('registers the handler on the real channel', () => {
    expect(IPC.sessionsSetModel).toBe('sessions:set-model')
    expect(indexSrc).toContain('IPC.sessionsSetModel')
  })

  it('gates the reconcile call on the instance actually changing', () => {
    const start = indexSrc.indexOf('IPC.sessionsSetModel')
    expect(start).toBeGreaterThan(-1)
    // Bounded by the next handler registration rather than a fixed width, so this doesn't
    // truncate the body or spill into sessionsSetRunOptions below it.
    const end = indexSrc.indexOf('IPC.sessionsSetRunOptions', start)
    expect(end).toBeGreaterThan(start)
    const body = indexSrc.slice(start, end)

    expect(
      body,
      'expected "previousInstanceId !== instanceId" gating the reconcile call — without it, ' +
        'every re-pin (even to the SAME instance) would reconcile, which is not what this ' +
        'branch is for and is untested if the condition silently changes shape.'
    ).toContain('if (previousInstanceId !== instanceId)')
    expect(body).toContain('reconcilePermissionModeForDriver(')
    // The reconcile call must be nested inside the gate, not merely present somewhere in the
    // handler — indexOf ordering pins that.
    const gateIndex = body.indexOf('if (previousInstanceId !== instanceId)')
    const reconcileIndex = body.indexOf('reconcilePermissionModeForDriver(')
    expect(reconcileIndex).toBeGreaterThan(gateIndex)
  })

  it("passes the NEW instance's own driver capabilities as the supported-modes argument", () => {
    const start = indexSrc.indexOf('IPC.sessionsSetModel')
    const end = indexSrc.indexOf('IPC.sessionsSetRunOptions', start)
    const body = indexSrc.slice(start, end)

    // Guards against the reconcile silently checking against the WRONG driver's capabilities
    // (e.g. the previous instance's, or the global default) — reconcilePermissionModeForDriver
    // has no way to catch that itself, since it just trusts whatever list it's handed.
    expect(body).toContain(
      'resolveInstanceDriver(settings.agent, instanceId).driver.capabilities.permissionModes'
    )
  })

  it('records the known gap: a re-pin to the SAME instance whose driver changed in settings does not reconcile', () => {
    // Not a bug to fix here — just pinning that the gate's blind spot is documented in the
    // source, so a future reader doesn't have to rediscover it from behaviour.
    expect(indexSrc).toMatch(/re-pin to the SAME instance whose driver\s*\n?\s*\/\/ was swapped/)
  })
})
