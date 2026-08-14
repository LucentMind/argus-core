import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createSession } from '../sessionStore'
import { createDetection } from '../../packs/detection'
import { createClaudeDriver } from '../drivers/claude'
import { fakeSdk, flush, canUseToolOf, capturingDriver, type FakeSdk } from './helpers/fakeSdk'
import {
  runBackgroundTurn,
  type BackgroundTurnDeps,
  type BackgroundTurnParams,
  type BackgroundTurnResult
} from '../background'
import type { AgentDriver, DriverSession, DriverSessionContext } from '../driver'
import type { AgentEvent } from '../../../../shared/agent-events'
import type { SessionMirrorLike } from '../session'
import { createImmediateQueue } from '../../ingestQueue'

// runBackgroundTurn is the routines primitive: one unattended turn in a windowless
// CaseSession, returning its outcome programmatically. It does NOT create the case or the
// session row — its caller does — so both are created explicitly here.
//
// The SDK `result` literals below are copied from session.test.ts, NOT invented. Note the
// shape: an errored turn is `subtype: 'success'` with `is_error: true` — `is_error` is the
// only discriminator the real CLI gives (see drivers/claude/index.ts AUTH_FAILURE_RE notes),
// and normalize.ts derives `turn.completed.status` from it alone.

const RESULT_SUCCESS = {
  type: 'result',
  subtype: 'success',
  session_id: '11111111-1111-4111-8111-111111111111',
  usage: { input_tokens: 5, output_tokens: 2 },
  total_cost_usd: 0.001,
  duration_ms: 10,
  is_error: false
}

const RESULT_ERROR = {
  type: 'result',
  subtype: 'success',
  session_id: '11111111-1111-4111-8111-111111111111',
  is_error: true,
  result: 'tool crashed'
}

const assistantText = (text: string): unknown => ({
  type: 'assistant',
  session_id: 'x',
  message: { content: [{ type: 'text', text }] }
})

let tmp: string, argusHome: string, db: DatabaseSync
let caseId: number, sessionId: number
let events: AgentEvent[]

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-bg-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  events = []
  caseId = createCase(db, argusHome, { slug: 'routine-x', title: 'Routine: x' }).id
  sessionId = createSession(db, 'routine-x', 'claude-agent-sdk').id
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function deps(sdk: FakeSdk, over: Partial<BackgroundTurnDeps> = {}): BackgroundTurnDeps {
  return {
    db,
    argusHome,
    detection: createDetection(),
    queue: createImmediateQueue(db, argusHome),
    skillsRoots: [],
    driver: createClaudeDriver(sdk.createQuery),
    onEvent: (e) => events.push(e),
    ...over
  }
}

function params(over: Partial<BackgroundTurnParams> = {}): BackgroundTurnParams {
  return {
    caseId,
    caseSlug: 'routine-x',
    sessionId,
    prompt: 'sweep',
    timeoutMs: 5000,
    ...over
  }
}

/** Wrap a driver so its session's `send` throws synchronously — the one failure that happens
 *  BEFORE any event can arrive, and therefore before the normal resolution paths exist. */
function throwingSendDriver(inner: AgentDriver, message: string): AgentDriver {
  return {
    ...inner,
    createSession(ctx: DriverSessionContext): DriverSession {
      const s = inner.createSession(ctx)
      return {
        ...s,
        send(): void {
          throw new Error(message)
        }
      }
    }
  }
}

/** Wrap a driver so every `turn.completed` it emits carries `status: 'interrupted'`.
 *
 *  The Claude driver can only produce 'success' or 'error' (normalize.ts derives the status
 *  from `is_error` alone), but `turn.completed.status` is a three-way union
 *  (shared/agent-events.ts) and the Copilot (`abort`), ACP (`stopReason: cancelled`) and Codex
 *  ('interrupted') drivers all emit the third value for a turn that was cut short. Its text is
 *  partial, so the runner must never report it as `ok` — and no Claude-driven test can reach
 *  that branch on its own. CaseSession.consume() re-emits driver events verbatim, so rewriting
 *  the stream here is the same wire shape those drivers put on it. */
function interruptedTurnDriver(inner: AgentDriver): AgentDriver {
  return {
    ...inner,
    createSession(ctx: DriverSessionContext): DriverSession {
      const s = inner.createSession(ctx)
      return {
        ...s,
        events(): AsyncIterable<AgentEvent> {
          return (async function* () {
            for await (const e of s.events()) {
              yield e.type === 'turn.completed'
                ? { ...e, payload: { ...e.payload, status: 'interrupted' as const } }
                : e
            }
          })()
        }
      }
    }
  }
}

/** Wrap a driver so `createSession` throws — construction failure, which happens INSIDE
 *  `new CaseSession(...)` and therefore before any promise, timer or event exists. */
function throwingCreateSessionDriver(inner: AgentDriver, message: string): AgentDriver {
  return {
    ...inner,
    createSession(): DriverSession {
      throw new Error(message)
    }
  }
}

describe('runBackgroundTurn', () => {
  it('runs one turn and returns the final assistant text', async () => {
    const sdk = fakeSdk()
    const p = runBackgroundTurn(deps(sdk), params({ timeoutMs: 5000 }))
    await flush()
    sdk.messages.push(assistantText('all quiet tonight'))
    sdk.messages.push(RESULT_SUCCESS)
    const r = await p
    expect(r).toEqual({ status: 'ok', text: 'all quiet tonight' })
  })

  it('interrupts and reports timeout when the turn exceeds timeoutMs', async () => {
    const sdk = fakeSdk()
    const r = await runBackgroundTurn(deps(sdk), params({ timeoutMs: 50 }))
    expect(r.status).toBe('timeout')
    expect(sdk.interrupt).toHaveBeenCalled()
    // Teardown DID run (so nothing leaks) — and the `session.exited` it emits must not
    // downgrade the already-decided timeout to 'failed'.
    expect(events.filter((e) => e.type === 'session.exited')).toHaveLength(1)
    expect(r.status).toBe('timeout')
  })

  it('interrupts and reports failed when params.signal aborts', async () => {
    // The app-quit seam: RoutinesService.stopForQuit() aborts this signal. It must produce a
    // REAL interrupt — the same session.stop() the timeout path uses — not a softer, purely
    // cosmetic settlement.
    const sdk = fakeSdk()
    const controller = new AbortController()
    const p = runBackgroundTurn(deps(sdk), params({ timeoutMs: 5000, signal: controller.signal }))
    await flush()
    controller.abort()
    const r = await p
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/quit/i)
    expect(sdk.interrupt).toHaveBeenCalled()
    expect(events.filter((e) => e.type === 'session.exited')).toHaveLength(1)
  })

  it('settles immediately, and arms no lingering timeoutMs timer, when the signal is already aborted', async () => {
    // The already-aborted path used to settle and then STILL run the two statements below the
    // signal check: arm a timeoutMs timer (up to 30 minutes) for a turn that had already ended,
    // and call session.send() into a session already mid-teardown. Neither corrupted the
    // RETURNED result (settle()'s own latch swallows the eventual no-op timer fire), so this can
    // only be caught by observing what got scheduled, not by asserting on `r` alone.
    vi.useFakeTimers()
    try {
      const sdk = fakeSdk()
      const controller = new AbortController()
      controller.abort()
      const p = runBackgroundTurn(deps(sdk), params({ timeoutMs: 5000, signal: controller.signal }))
      // Fake timers don't gate microtasks — session.stop()'s own teardown (driver interrupt,
      // event emission) still needs to run before `p` resolves.
      await vi.advanceTimersByTimeAsync(0)
      const r = await p
      expect(r.status).toBe('failed')
      expect(r.error).toMatch(/quit/i)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a signal that fires AFTER the turn already completed changes nothing', async () => {
    const sdk = fakeSdk()
    const controller = new AbortController()
    const p = runBackgroundTurn(deps(sdk), params({ timeoutMs: 5000, signal: controller.signal }))
    await flush()
    sdk.messages.push(assistantText('all quiet tonight'))
    sdk.messages.push(RESULT_SUCCESS)
    const r = await p
    controller.abort()
    expect(r).toEqual({ status: 'ok', text: 'all quiet tonight' })
  })

  it('reports failed when the turn errors', async () => {
    const sdk = fakeSdk()
    const p = runBackgroundTurn(deps(sdk), params({ timeoutMs: 5000 }))
    await flush()
    sdk.messages.push(RESULT_ERROR)
    const r = await p
    expect(r.status).toBe('failed')
  })

  it('does NOT report ok when the turn completes as interrupted', async () => {
    const sdk = fakeSdk()
    const driver = interruptedTurnDriver(createClaudeDriver(sdk.createQuery))
    const p = runBackgroundTurn(deps(sdk, { driver }), params({ timeoutMs: 5000 }))
    await flush()
    sdk.messages.push(assistantText('half an answ'))
    // A CLEAN result on the wire: were `status` the only thing checked against 'error', this
    // truncated turn would be reported as a clean `ok` with partial text.
    sdk.messages.push(RESULT_SUCCESS)
    const r = await p
    expect(r.status).not.toBe('ok')
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/interrupted/)
    // The partial text is still returned — it is just not certified as a completed turn.
    expect(r.text).toBe('half an answ')
  })

  // --- resolution model: exactly one resolution, teardown on every path ------------------

  it('tears the session down exactly once on the success path', async () => {
    const sdk = fakeSdk()
    let closed = 0
    const mirror: SessionMirrorLike = {
      append: () => undefined,
      indexText: () => undefined,
      close: () => {
        closed++
      }
    }
    const p = runBackgroundTurn(
      deps(sdk, { mirrorFactory: () => mirror }),
      params({ timeoutMs: 5000 })
    )
    await flush()
    sdk.messages.push(assistantText('done'))
    sdk.messages.push(RESULT_SUCCESS)
    await p
    // The mirror is write-behind; without stop() its buffered events never reach disk.
    expect(closed).toBe(1)
    expect(events.filter((e) => e.type === 'session.exited')).toHaveLength(1)
    // A late event after resolution must not resolve a second time or throw.
    //
    // HONESTY NOTE: this is a smoke check, not a proof of the write-once latch. A second
    // `resolve()` on a settled promise is a silent no-op and `stop()` early-returns once the
    // session is 'dead', so removing the `if (outcome) return` guard would still leave this
    // green. Proving it directly would mean exporting a resolve counter from production code
    // purely for the test; the assertions below are what CAN be observed from outside — no
    // second teardown, and the settled value unchanged.
    sdk.messages.push(RESULT_ERROR)
    await flush()
    expect(closed).toBe(1)
    expect(events.filter((e) => e.type === 'session.exited')).toHaveLength(1)
    await expect(p).resolves.toEqual({ status: 'ok', text: 'done' })
  })

  it('resolves failed and still tears down when send() throws synchronously', async () => {
    const sdk = fakeSdk()
    const driver = throwingSendDriver(createClaudeDriver(sdk.createQuery), 'driver send exploded')
    const r = await runBackgroundTurn(deps(sdk, { driver }), params({ timeoutMs: 5000 }))
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/driver send exploded/)
    expect(events.filter((e) => e.type === 'session.exited')).toHaveLength(1)
  })

  it('resolves failed (never throws synchronously) when the session cannot be constructed', async () => {
    const sdk = fakeSdk()
    const driver = throwingCreateSessionDriver(
      createClaudeDriver(sdk.createQuery),
      'cannot build session'
    )
    // The assertion that matters is that CALLING it does not throw: runBackgroundTurn is typed
    // `Promise<BackgroundTurnResult>`, so a synchronous throw is invisible to a caller holding
    // `.catch()` on the returned promise (Task 6 is that caller). Constructing the CaseSession
    // does real work — touchSession, caseDir, driver.createSession — so it genuinely can throw.
    let p: Promise<BackgroundTurnResult>
    expect(() => {
      p = runBackgroundTurn(deps(sdk, { driver }), params({ timeoutMs: 5000 }))
    }).not.toThrow()
    const r = await p!
    expect(r).toEqual({ status: 'failed', text: '', error: 'cannot build session' })
    // Nothing was constructed, so nothing may be torn down: no stop(), hence no session.exited.
    expect(events).toHaveLength(0)
  })

  it('reports failed when the session exits before the turn completes', async () => {
    const sdk = fakeSdk()
    const p = runBackgroundTurn(deps(sdk), params({ timeoutMs: 5000 }))
    await flush()
    // The driver stream ending with no `result` message: the session emits session.exited
    // and the turn never completes. Without a resolution here the caller would hang until
    // the timeout, so this path must settle on its own.
    sdk.messages.end()
    const r = await p
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/exited/i)
  })

  it('forwards every session event to onEvent', async () => {
    const sdk = fakeSdk()
    const p = runBackgroundTurn(deps(sdk), params({ timeoutMs: 5000 }))
    await flush()
    sdk.messages.push(assistantText('hello'))
    sdk.messages.push(RESULT_SUCCESS)
    await p
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['turn.started', 'assistant.message', 'turn.completed'])
    )
  })

  // --- the containment that makes an unattended turn safe AND unable to hang -------------

  it('runs unattended: an ask-level tool is denied instead of opening an approval', async () => {
    const sdk = fakeSdk()
    const p = runBackgroundTurn(deps(sdk), params({ timeoutMs: 5000 }))
    const canUse = await canUseToolOf(sdk)
    // PendingApprovals has NO timeout — without `unattended: true` this await never resolves
    // and the turn hangs until timeoutMs on every ask-level call.
    const out = await canUse(
      'mcp__argus__write_memory',
      { content: 'x' },
      { signal: new AbortController().signal }
    )
    expect(out.behavior).toBe('deny')
    expect(out.message).toMatch(/unattended/i)
    expect(events.some((e) => e.type === 'request.opened')).toBe(false)
    sdk.messages.push(RESULT_SUCCESS)
    await p
  })

  it('registers no connector MCP servers and sets no permission mode', async () => {
    const sdk = fakeSdk()
    const p = runBackgroundTurn(deps(sdk), params({ timeoutMs: 5000 }))
    await canUseToolOf(sdk) // guarantees the driver installed its options bag
    // Omitting extraMcpServers entirely is the containment: no Jira/GitHub connector write
    // tool can ever be registered in a background session.
    expect(Object.keys(sdk.captured.options!.mcpServers as Record<string, unknown>)).toEqual([
      'argus'
    ])
    // Never set a permission mode: bypassPermissions/acceptEdits skip the deny seams.
    expect(sdk.captured.options!.permissionMode).toBeUndefined()
    expect(sdk.captured.options!.allowDangerouslySkipPermissions).toBeUndefined()
    sdk.messages.push(RESULT_SUCCESS)
    await p
  })

  // --- defectCorpus: the live defect this task fixes -------------------------------------

  it('passes defectCorpus through to the session, so search_known_defects works unattended', async () => {
    // The bug: BackgroundTurnDeps had no defectCorpus field at all, so registry.ts's
    // interactive sessions got the corpus and background turns never did — every routine run
    // took search_known_defects's no-sources fallback, a plausible STRING and not an error.
    // capturingDriver (the same DI seam turnRunner.test.ts's `contextOf` uses) captures the
    // DriverSessionContext CaseSession actually built, so this proves the dep reaches
    // nativeToolDeps.defectCorpus — the exact place the tool handler reads it — without
    // mocking the session module.
    const sdk = fakeSdk()
    const corpus = { searchAll: async () => [] } as unknown as BackgroundTurnDeps['defectCorpus']
    const { driver, ctx } = capturingDriver(createClaudeDriver(sdk.createQuery))
    const p = runBackgroundTurn(deps(sdk, { defectCorpus: corpus, driver }), params())
    await flush()
    sdk.messages.push(RESULT_SUCCESS)
    await p
    expect(ctx().nativeToolDeps.defectCorpus).toBe(corpus)
  })

  // --- the routine item id: what makes propose_case_triage reachable at all ---------------

  it('gives the session the run item id its turn is processing', async () => {
    // `propose_case_triage` writes to `routine_run_items.suggestion` and gets the row id from
    // `nativeToolDeps.currentRunItemId` — the exact place asserted here. Nothing threaded an
    // item id into a turn before this, so the tool was unreachable in production while both
    // ends of the chain had passing tests of their own.
    const sdk = fakeSdk()
    const { driver, ctx } = capturingDriver(createClaudeDriver(sdk.createQuery))
    const p = runBackgroundTurn(deps(sdk, { driver }), params({ runItemId: 77 }))
    await flush()
    sdk.messages.push(RESULT_SUCCESS)
    await p
    expect(ctx().nativeToolDeps.currentRunItemId?.()).toBe(77)
  })

  it('carries NO item thunk when the turn has no item, which is the advertisement gate', async () => {
    // session.ts and nativeTools.ts both gate on `currentRunItemId != null` — the thunk being
    // PRESENT, not what it returns. An unconditional thunk here would advertise
    // propose_case_triage to every unscoped routine turn, where it can only ever refuse.
    const sdk = fakeSdk()
    const { driver, ctx } = capturingDriver(createClaudeDriver(sdk.createQuery))
    const p = runBackgroundTurn(deps(sdk, { driver }), params())
    await flush()
    sdk.messages.push(RESULT_SUCCESS)
    await p
    expect(ctx().nativeToolDeps.currentRunItemId).toBeUndefined()
  })

  it('still constructs a session when defectCorpus is absent, as tests and headless hosts do', async () => {
    const sdk = fakeSdk()
    const { driver, ctx } = capturingDriver(createClaudeDriver(sdk.createQuery))
    const p = runBackgroundTurn(deps(sdk, { driver }), params())
    await flush()
    sdk.messages.push(RESULT_SUCCESS)
    await p
    expect(ctx().nativeToolDeps.defectCorpus).toBeUndefined()
  })
})
