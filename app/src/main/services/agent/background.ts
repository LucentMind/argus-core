import type { DatabaseSync } from 'node:sqlite'
import { CaseSession, type SessionMirrorLike } from './session'
import type { AgentDriver } from './driver'
import type { Detection } from '../packs/detection'
import type { AgentEvent } from '../../../shared/agent-events'
import type { AgentAccess } from '../../../shared/agentAccess'
import type { RiskLevel } from '../../../shared/connectors'

// Deliberately imports NO electron. The routines engine must stay pure Node so a future
// headless server can host it; event forwarding is the injected `onEvent` callback only.

export interface BackgroundTurnDeps {
  db: DatabaseSync
  argusHome: string
  detection: Detection
  skillsRoots: string[]
  driver: AgentDriver
  /**
   * SESSION-SHAPE DEPS — the ones an interactive session gets from AgentService.getOrCreate
   * (registry.ts) and a background session must get too. They are INJECTED rather than derived
   * here because their live sources (the agent-access store, the tool-risk store, the pack
   * registry) are host-owned; `routines/turnRunner.ts` is what binds them in production.
   *
   * Each one is absent-safe so existing tests keep constructing a bare deps object, but leaving
   * any of them out in production is a real behaviour difference, not a missing nicety:
   *  - no `enabledSkills`  -> `session.ts` passes `skills: []`, so the run has NO Argus skills;
   *  - no `skillIndex`     -> the skills are loadable but never advertised, which defeats
   *                           passing `enabledSkills` at all;
   *  - no `agentAccess`    -> `session.ts` falls back to `defaultAgentAccess()`, which INJECTS
   *                           memory topics the user explicitly disabled on the Knowledge page.
   *                           That is a user-facing privacy control, so this one is the reason
   *                           the whole group exists;
   *  - no `toolRisk`       -> the user's connector-tool risk overrides are ignored. INERT today
   *                           and passed for correctness only: risk.ts consults `toolRisk` on
   *                           the generic `mcp__<server>__<tool>` branch alone, which sits below
   *                           the hardcoded native-tool table, and a background session
   *                           registers no connector servers at all;
   *  - no `packCliNames`   -> pack analysis CLIs lose their LOW-risk allowlist (`risk.ts`).
   *                           NARROWER than it sounds, and verified rather than assumed: an
   *                           unrecognized bash program already defaults to allow/LOW, so this
   *                           only decides anything for a pack CLI whose name collides with the
   *                           raw-text-tool list (grep/rg/cat/…) on an `evidence/` path — which
   *                           is MEDIUM-ask, and every ask is DENIED under `unattended`.
   *
   * DELIBERATELY NOT HERE: `personaFragments` / `personaFragmentIds`. A persona written to help
   * a human triage a defect and a persona for unattended automation are different things, so
   * inheriting the interactive one would be wrong rather than merely incomplete. The
   * automation-side identity is supplied by the unattended preamble `RoutinesService` prepends
   * to the prompt; a purpose-built automation persona is future work.
   */
  /** Driver-visible skill allowlist (assembleMode). */
  enabledSkills?: string[]
  /** Prompt-visible skill index, so the model knows the allowlisted skills exist. */
  skillIndex?: string
  /** Pack-declared CLI binary names — their LOW-risk allowlist in risk.ts. */
  packCliNames?: string[]
  /** Live agent-access overrides (skills/memory); consulted per session construction. */
  agentAccess?: () => AgentAccess
  /** Live tool-risk overrides; consulted per classification. */
  toolRisk?: () => Record<string, RiskLevel>
  /** Forwarded every session event (e.g. index.ts broadcast) so an open window can watch live. */
  onEvent?: (e: AgentEvent) => void
  mirrorFactory?: (caseSlug: string, sessionId: number) => SessionMirrorLike
}

export interface BackgroundTurnParams {
  caseId: number
  caseSlug: string
  sessionId: number
  prompt: string
  timeoutMs: number
  model?: string
}

export interface BackgroundTurnResult {
  status: 'ok' | 'failed' | 'timeout'
  text: string
  error?: string
}

/**
 * One unattended turn in a windowless CaseSession, resolved programmatically.
 *
 * TRUST BOUNDARY (structural, not advisory):
 *  - `unattended: true` — every ask-level verdict denies at BOTH seams and AskUserQuestion
 *    auto-dismisses (session.ts). This is also what makes the turn unable to hang:
 *    PendingApprovals/PendingDialogs have no timeout, so an ask with no renderer to answer it
 *    would block forever.
 *  - NO `extraMcpServers` — omitting the field entirely is the containment that keeps
 *    connector write tools (Jira/GitHub) from ever being registered in a background session.
 *  - NO `permissionMode` — `bypassPermissions` and `acceptEdits` let some driver skip both
 *    deny seams. session.ts downgrades them under unattended, but this never sets one at all
 *    rather than relying on that.
 *
 * RESOLUTION MODEL — one latch, one teardown, one resolve:
 *  `outcome` is a write-once latch. The first caller of `settle()` decides the result and is
 *  the only one that triggers teardown; every later event — including the `session.exited`
 *  that `stop()` itself emits, a late `turn.completed`, or a second error — re-enters
 *  `settle()`, sees the latch, and is ignored. So the timeout path cannot be overwritten by
 *  its own teardown, and `resolve` runs exactly once. Teardown is unconditional: `stop()`
 *  runs on every path (success, failure, timeout, a synchronous `send()` throw) so the mirror
 *  flushes and no session leaks, and the promise resolves whether it settles or rejects — a
 *  teardown failure must not strand the caller.
 *
 *  CONSTRUCTION IS INSIDE THAT MODEL TOO. `new CaseSession(...)` does real work
 *  (`touchSession`, `caseDir`, `driver.createSession`), so it can throw. That throw is caught
 *  and reported as a resolved `{ status: 'failed' }` — the SAME channel as a synchronous
 *  `send()` throw — because this function's signature is `Promise<BackgroundTurnResult>` and a
 *  synchronous throw out of it is invisible to a caller holding `.catch()` on the returned
 *  promise. `settle()` is the only teardown site and skips `stop()` when `session` is still
 *  undefined: nothing was constructed, so there is nothing to tear down.
 */
export function runBackgroundTurn(
  deps: BackgroundTurnDeps,
  params: BackgroundTurnParams
): Promise<BackgroundTurnResult> {
  let resolveResult!: (r: BackgroundTurnResult) => void
  const done = new Promise<BackgroundTurnResult>((r) => {
    resolveResult = r
  })

  let lastText = ''
  let outcome: BackgroundTurnResult | null = null
  let timer: NodeJS.Timeout | undefined

  const settle = (r: BackgroundTurnResult): void => {
    if (outcome) return
    outcome = r
    // Disarmed, not just cleared: `timer` is also undefined for the window before it is armed
    // below, so the guard covers a future early settle() as well as this one.
    if (timer) clearTimeout(timer)
    timer = undefined
    const finish = (): void => resolveResult(r)
    // `session` is undefined only when construction itself threw — there is no session to
    // stop, and calling stop() on a half-built one is exactly what must not happen.
    if (!session) {
      finish()
      return
    }
    void session.stop('stopped').then(finish, finish)
  }

  const emit = (e: AgentEvent): void => {
    deps.onEvent?.(e)
    switch (e.type) {
      case 'assistant.message':
        lastText = e.payload.text
        break
      case 'turn.completed':
        // `status` is 'success' | 'error' | 'interrupted' (shared/agent-events.ts). Only
        // 'success' is a clean turn: 'interrupted' is emitted by the Copilot (`abort`), ACP
        // (`stopReason: cancelled`) and Codex ('interrupted') drivers for a turn that was cut
        // short, so its text is partial and it must never be reported as ok.
        settle(
          e.payload.status === 'success'
            ? { status: 'ok', text: lastText }
            : { status: 'failed', text: lastText, error: `turn ended: ${e.payload.status}` }
        )
        break
      case 'session.error':
        settle({ status: 'failed', text: lastText, error: e.payload.message })
        break
      case 'session.exited':
        // Only decides anything when the stream ends BEFORE a turn boundary; the exit emitted
        // during our own teardown always arrives with the latch already set.
        settle({
          status: 'failed',
          text: lastText,
          error: `session exited (${e.payload.reason}) before the turn completed`
        })
        break
    }
  }

  // Safe to reference from `settle`/`emit` above: no event can be emitted synchronously during
  // construction (CaseSession defers its own startup emits to a microtask and `consume()`
  // awaits the driver stream before yielding anything), so this binding is always assigned
  // by the time either closure runs on a session that was built at all.
  let session: CaseSession | undefined
  try {
    session = new CaseSession({
      db: deps.db,
      argusHome: deps.argusHome,
      detection: deps.detection,
      caseId: params.caseId,
      caseSlug: params.caseSlug,
      sessionId: params.sessionId,
      workspaceRoots: [],
      skillsRoots: deps.skillsRoots,
      // See the SESSION-SHAPE DEPS note on BackgroundTurnDeps. `personaFragments` /
      // `personaFragmentIds` are absent BY DECISION, not by omission.
      enabledSkills: deps.enabledSkills,
      skillIndex: deps.skillIndex,
      packCliNames: deps.packCliNames,
      agentAccess: deps.agentAccess,
      toolRisk: deps.toolRisk,
      emit,
      driver: deps.driver,
      resumeCursor: null,
      unattended: true,
      mirror: deps.mirrorFactory?.(params.caseSlug, params.sessionId),
      ...(params.model ? { agentOptions: { model: params.model } } : {})
    })
  } catch (err) {
    // Reported, not thrown: see the CONSTRUCTION note above. The timeout is not armed yet, so
    // settle()'s `if (timer)` guard covers this path unchanged.
    settle({ status: 'failed', text: '', error: err instanceof Error ? err.message : String(err) })
    return done
  }

  timer = setTimeout(() => {
    // Latching 'timeout' BEFORE stop() is what makes the timeout stick: stop() interrupts the
    // driver and emits session.exited, which would otherwise settle as 'failed'.
    settle({ status: 'timeout', text: lastText, error: `timed out after ${params.timeoutMs}ms` })
  }, params.timeoutMs)

  try {
    session.send(params.prompt)
  } catch (err) {
    // A synchronous send() failure happens before any event exists, so it is the one path the
    // event handlers above can never cover. It still goes through settle(), so it still tears
    // the session down.
    settle({ status: 'failed', text: '', error: err instanceof Error ? err.message : String(err) })
  }

  return done
}
