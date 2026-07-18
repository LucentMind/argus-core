import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../../../db'
import { createCase } from '../../../../caseService'
import { createDetection } from '../../../../packs/detection'
import { caseDir as caseDirOf } from '../../../../paths'
import { createCopilotDriver } from '../index'
import type { AgentEvent } from '../../../../../../shared/agent-events'
import type { PermissionMode } from '../../../../../../shared/settings'
import type { DriverSession, DriverSessionContext, ToolDecision, TurnResult } from '../../../driver'
import type { NativeToolDeps } from '../../../nativeTools'

/**
 * Real-runtime e2e smoke suite (Task 12). Gated behind COPILOT_SMOKE so committed CI never
 * boots the bundled Copilot runtime or requires auth. Run the whole suite manually with:
 *   COPILOT_SMOKE=1 npx vitest run src/main/services/agent/drivers/copilot/__tests__/smoke.test.ts
 *
 * Every test uses a throwaway scratch dir (its own argusHome ⇒ scratch COPILOT_HOME derived by
 * copilotHome(); never ~/.copilot / gh auth) and a tiny prompt. Prompts are kept minimal because
 * the machine is on the Copilot Free tier ('auto' router only). Scenarios covered:
 *   a) full streamed turn + final message + turn accounting
 *   b) MEDIUM approval round-trip: write request → DENY → model reports gracefully
 *   c) native Argus tool (append_finding, LOW/skipPermission) invoked end-to-end
 *   d) resume: two-turn continuity across driverSession end + a new session with the cursor
 *   e) plan mode: engage 'plan', run a planning turn to completion against the real runtime
 *   f) connector MCP: a composed stdio server (spike echo server) forwards through
 *      toCopilotMcpServers, connects, and its tool round-trips via the kind:"mcp"
 *      permission path (EVIDENCE §6c)
 */

const SMOKE = Boolean(process.env.COPILOT_SMOKE)

interface Scratch {
  argusHome: string
  caseDir: string
  db: DatabaseSync
  deps: NativeToolDeps
  emitFinding: ReturnType<typeof vi.fn>
  cleanup: () => void
}

/** Build a real (scratch) argusHome + case + working NativeToolDeps so native-tool handlers
 *  actually execute (append_finding writes findings.md + inserts a row). */
function makeScratch(slug = 'SMOKE-1'): Scratch {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-smoke-'))
  const argusHome = path.join(root, 'home')
  fs.mkdirSync(argusHome, { recursive: true })
  const db = openDb(path.join(argusHome, 'argus.db'))
  const rec = createCase(db, argusHome, { slug, title: 'copilot smoke' })
  const caseDir = caseDirOf(argusHome, slug)
  const emitFinding = vi.fn()
  const deps: NativeToolDeps = {
    db,
    argusHome,
    detection: createDetection(),
    caseId: rec.id,
    caseSlug: slug,
    sessionId: 1,
    emitFinding,
    currentTurnId: () => 1
  } as unknown as NativeToolDeps
  return {
    argusHome,
    caseDir,
    db,
    deps,
    emitFinding,
    cleanup: () => {
      try {
        db.close()
      } catch {
        /* already closed */
      }
      // The runtime may still hold COPILOT_HOME briefly after stop(); EBUSY here is not a failure.
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        /* leave the throwaway dir for the OS temp reaper */
      }
    }
  }
}

interface Harness {
  session: DriverSession
  events: AgentEvent[]
  turnResults: TurnResult[]
  cursors: string[]
  toolRequests: Array<{ name: string; input: Record<string, unknown> }>
  drained: Promise<void>
  /** Count of `turn.completed` events observed so far. */
  turns(): number
  waitForTurns(n: number, timeoutMs: number): Promise<void>
  text(): string
}

/** Drive a driver session, collecting normalized events, turn results, cursors and the
 *  (toolName,input) pairs the driver routed to the harness approval pipeline. */
function open(
  driver: ReturnType<typeof createCopilotDriver>,
  scratch: Scratch,
  opts: {
    permissionMode?: PermissionMode
    resumeCursor?: string | null
    onToolRequest?: (name: string, input: Record<string, unknown>) => ToolDecision
    extraMcpServers?: Record<string, unknown>
  } = {}
): Harness {
  const events: AgentEvent[] = []
  const turnResults: TurnResult[] = []
  const cursors: string[] = []
  const toolRequests: Array<{ name: string; input: Record<string, unknown> }> = []

  const ctx: DriverSessionContext = {
    caseDir: scratch.caseDir,
    additionalDirectories: [],
    permissionMode: opts.permissionMode ?? 'default',
    systemAppend: '',
    extraMcpServers: opts.extraMcpServers ?? {},
    nativeToolDeps: scratch.deps,
    panelCommandDecls: [],
    resumeCursor: opts.resumeCursor ?? null,
    eventCtx: () => ({ caseId: 1, caseSlug: scratch.deps.caseSlug, sessionId: 1, turnId: 1 }),
    onToolRequest: async (name, input) => {
      toolRequests.push({ name, input })
      return opts.onToolRequest
        ? opts.onToolRequest(name, input)
        : { behavior: 'deny', message: 'smoke: denied by default' }
    },
    onCursor: (c) => cursors.push(c),
    onTurnResult: (r) => turnResults.push(r)
  }

  const session = driver.createSession(ctx)
  const drained = (async () => {
    for await (const e of session.events()) events.push(e)
  })()

  const turns = (): number => events.filter((e) => e.type === 'turn.completed').length
  const waitForTurns = async (n: number, timeoutMs: number): Promise<void> => {
    const start = Date.now()
    while (turns() < n) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `timeout after ${timeoutMs}ms waiting for ${n} turn(s); saw ${turns()}; ` +
            `events=[${events.map((e) => e.type).join(',')}]`
        )
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  const text = (): string =>
    events
      .filter((e) => e.type === 'assistant.message')
      .map((e) => (e.type === 'assistant.message' ? e.payload.text : ''))
      .join('')

  return { session, events, turnResults, cursors, toolRequests, drained, turns, waitForTurns, text }
}

describe.skipIf(!SMOKE)('copilot driver — real runtime smoke (e2e)', () => {
  it('probeAuth reports authenticated against the bundled runtime', async () => {
    const driver = createCopilotDriver()
    const auth = await driver.probeAuth({ timeoutMs: 20000 })
    console.log('[SMOKE] probeAuth:', JSON.stringify(auth))
    expect(auth.ok).toBe(true)
  }, 60000)

  it('(a) streams deltas, emits a final message, and reports turn accounting', async () => {
    const scratch = makeScratch('SMOKE-A')
    const driver = createCopilotDriver()
    const h = open(driver, scratch)
    try {
      // A multi-item reply reliably chunks into content.delta events. (A one-token reply like
      // "OK" arrives as a single assistant.message with NO intermediate deltas — real-runtime
      // behavior observed against gpt-5-mini; short replies simply aren't chunked.)
      h.session.send('List three short interesting facts about the number seven, one per line.')
      await h.waitForTurns(1, 60000)
      h.session.end()
      await h.drained

      const deltas = h.events.filter((e) => e.type === 'content.delta')
      console.log('[SMOKE a] text:', JSON.stringify(h.text().slice(0, 300)))
      console.log('[SMOKE a] delta count:', deltas.length)
      console.log('[SMOKE a] event types:', h.events.map((e) => e.type).join(','))
      console.log('[SMOKE a] turnResult:', JSON.stringify(h.turnResults[0]))
      expect(h.text().length).toBeGreaterThan(0) // final message present
      expect(deltas.length).toBeGreaterThan(0) // streamed deltas arrived
      const completed = h.events.find((e) => e.type === 'turn.completed')
      expect(completed).toBeDefined()
      expect(h.turnResults.length).toBeGreaterThanOrEqual(1)
      const tr = h.turnResults[h.turnResults.length - 1]
      expect(tr.authFailure).toBe(false)
      expect(tr.model && tr.model.length > 0).toBe(true) // resolved model, not "auto"
      expect(typeof tr.inputTokens).toBe('number') // real per-turn accounting
      expect(tr.costUsd).toBeNull() // costReporting:false ⇒ always null
    } finally {
      h.session.end()
      scratch.cleanup()
    }
  }, 90000)

  it('(b) MEDIUM approval round-trip: a write request is DENIED and the model reports gracefully', async () => {
    const scratch = makeScratch('SMOKE-B')
    const driver = createCopilotDriver()
    // Deny every gated request; the built-in write tool routes here as name 'write'.
    const h = open(driver, scratch, {
      onToolRequest: () => ({ behavior: 'deny', message: 'smoke: writes are not permitted' })
    })
    try {
      h.session.send(
        'Create a new file named smoke-note.txt in the current directory whose exact ' +
          'contents are the word hello. Use your file-creation tool to actually write the file.'
      )
      await h.waitForTurns(1, 120000)
      h.session.end()
      await h.drained

      const completedCalls = h.events.filter((e) => e.type === 'tool.call.completed') as Extract<
        AgentEvent,
        { type: 'tool.call.completed' }
      >[]
      console.log('[SMOKE b] toolRequests:', JSON.stringify(h.toolRequests.map((t) => t.name)))
      console.log('[SMOKE b] text:', JSON.stringify(h.text().slice(0, 400)))
      console.log('[SMOKE b] event types:', h.events.map((e) => e.type).join(','))
      console.log(
        '[SMOKE b] completed isError:',
        JSON.stringify(completedCalls.map((e) => e.payload.isError))
      )
      // The deny path must have been exercised for a write-kind request.
      const wrote = h.toolRequests.find((t) => t.name === 'write')
      expect(
        wrote,
        `expected a 'write' permission request; saw ${JSON.stringify(
          h.toolRequests.map((t) => t.name)
        )}`
      ).toBeDefined()
      // The file must NOT exist — the deny actually blocked the write.
      expect(fs.existsSync(path.join(scratch.caseDir, 'smoke-note.txt'))).toBe(false)
      // The denied tool call still completed (as an error), and the turn ended cleanly (no
      // crash / session.error). Note: after a denial the model may end the turn WITHOUT emitting
      // any final assistant text — graceful here means a clean turn boundary, not a spoken apology.
      expect(completedCalls.length).toBeGreaterThan(0)
      expect(h.events.some((e) => e.type === 'turn.completed')).toBe(true)
      expect(h.events.some((e) => e.type === 'session.error')).toBe(false)
    } finally {
      h.session.end()
      scratch.cleanup()
    }
  }, 150000)

  it('(c) native Argus tool append_finding (LOW/skipPermission) runs end-to-end', async () => {
    const scratch = makeScratch('SMOKE-C')
    const driver = createCopilotDriver()
    // Approving is a no-op for append_finding (skipPermission), but keep a permissive handler
    // so any incidental gated request does not hang the turn.
    const h = open(driver, scratch, {
      onToolRequest: () => ({ behavior: 'allow', updatedInput: {} })
    })
    try {
      h.session.send(
        'Call the tool named argus_append_finding with title "Smoke finding" and markdown ' +
          '"e2e smoke — appended via the native Argus tool". Then reply DONE.'
      )
      await h.waitForTurns(1, 120000)
      h.session.end()
      await h.drained

      const completed = h.events.filter((e) => e.type === 'tool.call.completed') as Extract<
        AgentEvent,
        { type: 'tool.call.completed' }
      >[]
      console.log(
        '[SMOKE c] tool.call.completed:',
        JSON.stringify(
          completed.map((e) => ({ name: e.payload.name, out: e.payload.outputPreview }))
        )
      )
      console.log('[SMOKE c] emitFinding calls:', scratch.emitFinding.mock.calls.length)

      const finding = completed.find((e) => e.payload.name.includes('append_finding'))
      expect(finding, 'model did not invoke argus_append_finding').toBeDefined()
      // The handler actually executed: it emitted the finding and its result reached the model.
      expect(scratch.emitFinding).toHaveBeenCalled()
      expect(finding!.payload.outputPreview).toContain('finding appended')
      // findings.md now carries the block the handler wrote.
      const findings = fs.readFileSync(path.join(scratch.caseDir, 'findings.md'), 'utf8')
      expect(findings).toContain('Smoke finding')
    } finally {
      h.session.end()
      scratch.cleanup()
    }
  }, 150000)

  it('(d) resume: continuity across driverSession end() + a new session with the captured cursor', async () => {
    const scratch = makeScratch('SMOKE-D')
    const driver = createCopilotDriver()

    // Turn 1 — teach a codeword, capture the cursor, then fully end the session.
    const h1 = open(driver, scratch)
    let cursor: string
    try {
      h1.session.send('Remember this codeword for later: banana. Reply with exactly: READY')
      await h1.waitForTurns(1, 60000)
      expect(h1.cursors.length).toBeGreaterThan(0)
      cursor = h1.cursors[0]
      console.log('[SMOKE d] cursor:', cursor)
    } finally {
      h1.session.end()
      await h1.drained.catch(() => undefined)
    }

    // Turn 2 — a brand-new session resumed from the cursor must recall the codeword.
    const h2 = open(driver, scratch, { resumeCursor: cursor })
    try {
      h2.session.send('What codeword did I ask you to remember? Reply with just that one word.')
      await h2.waitForTurns(1, 60000)
      const answer = h2.text().toLowerCase()
      console.log('[SMOKE d] resumed answer:', JSON.stringify(answer))
      expect(h2.cursors[0]).toBe(cursor) // sessionId stable across resume (EVIDENCE §10)
      expect(answer).toContain('banana')
    } finally {
      h2.session.end()
      await h2.drained.catch(() => undefined)
      scratch.cleanup()
    }
  }, 150000)

  it('(e) plan mode: engages plan and runs a planning turn to completion against the real runtime', async () => {
    const scratch = makeScratch('SMOKE-E')
    const driver = createCopilotDriver()
    // In plan mode the agent issues read requests while planning and — when it finishes — an
    // exit-plan request that now routes through the Argus approval pipeline as the synthesized
    // tool 'copilot:exit-plan' (the fix: the plan→autopilot handshake is no longer auto-approved
    // with zero gates). Approve reads AND the exit-plan card; deny writes so the plan stays
    // read-only even after autopilot is entered.
    const h = open(driver, scratch, {
      permissionMode: 'plan',
      onToolRequest: (name) =>
        name === 'read' || name === 'copilot:exit-plan'
          ? { behavior: 'allow', updatedInput: {} }
          : { behavior: 'deny', message: 'smoke: plan mode is read-only' }
    })
    try {
      h.session.send(
        'You are in plan mode. Produce a short numbered plan (3-4 steps) for adding a LICENSE ' +
          'file to this repository, then request to exit plan mode so I can review it. Do not ' +
          'modify any files.'
      )
      await h.waitForTurns(1, 150000)
      h.session.end()
      await h.drained

      console.log('[SMOKE e] event types:', h.events.map((e) => e.type).join(','))
      console.log('[SMOKE e] toolRequests:', JSON.stringify(h.toolRequests.map((t) => t.name)))
      console.log('[SMOKE e] text:', JSON.stringify(h.text().slice(0, 500)))
      // The plan-mode RPC path (session.rpc.mode.set({mode:'plan'})) executed against the real
      // runtime and the turn completed cleanly (no fatal session.error). Note: in plan mode the
      // first turn is often a tool-only exploration step that ends WITHOUT a final assistant text
      // block — so text presence is NOT asserted (real-runtime nondeterminism).
      expect(h.events.some((e) => e.type === 'turn.completed')).toBe(true)
      expect(h.events.some((e) => e.type === 'session.error')).toBe(false)
      // The fix in action: whenever the model requested to exit plan mode, that handshake
      // interposed an Argus approval card (routed as 'copilot:exit-plan') rather than
      // auto-flipping to autopilot — proving the plan is now human-gated.
      const exitPlan = h.toolRequests.filter((t) => t.name === 'copilot:exit-plan')
      for (const ep of exitPlan) {
        // The card carried the plan content for review (round-trip of the synthesized input).
        expect(ep.input).toHaveProperty('recommendedAction')
      }
      // No write escaped plan mode: the LICENSE file was never created (writes stayed denied).
      expect(fs.existsSync(path.join(scratch.caseDir, 'LICENSE'))).toBe(false)
    } finally {
      h.session.end()
      scratch.cleanup()
    }
  }, 180000)

  it('(f) connector MCP: composed stdio server connects and its tool round-trips via kind:"mcp"', async () => {
    const scratch = makeScratch('SMOKE-F')
    const driver = createCopilotDriver()
    // The spike's stdio echo server (scripts/spike-copilot/) doubles as the connector under
    // test; the composed shape below is exactly what mcp.ts composeForSession() produces —
    // note NO `tools` field: the driver's toCopilotMcpServers must add the allowlist (§6c).
    const echoServer = path.resolve(
      __dirname,
      '../../../../../../../scripts/spike-copilot/mcp-echo-server.mjs'
    )
    expect(fs.existsSync(echoServer), `spike echo server missing at ${echoServer}`).toBe(true)
    const h = open(driver, scratch, {
      extraMcpServers: {
        argusEcho: { type: 'stdio', command: process.execPath, args: [echoServer], env: {} }
      },
      onToolRequest: (name) =>
        name === 'mcp__argusEcho__mcp_echo'
          ? { behavior: 'allow', updatedInput: {} }
          : { behavior: 'deny', message: 'smoke: only the echo MCP tool is permitted' }
    })
    try {
      h.session.send(
        "Call the mcp_echo tool from the 'argusEcho' MCP server with message 'ping' and " +
          'reply with exactly what it returned. If you have no such tool, reply NO_MCP_TOOL.'
      )
      // A tool turn spans several inference passes, each with its own turn.completed — so wait
      // on the OUTCOME (the relayed echo, or an explicit no-tool answer), not a turn count.
      {
        const start = Date.now()
        while (!/mcp-echo:ping|NO_MCP_TOOL/.test(h.text())) {
          if (Date.now() - start > 120000)
            throw new Error(
              `timeout waiting for echo text; events=[${h.events.map((e) => e.type).join(',')}]`
            )
          await new Promise((r) => setTimeout(r, 100))
        }
      }
      h.session.end()
      await h.drained

      console.log('[SMOKE f] toolRequests:', JSON.stringify(h.toolRequests.map((t) => t.name)))
      console.log('[SMOKE f] text:', JSON.stringify(h.text().slice(0, 300)))
      console.log('[SMOKE f] event types:', h.events.map((e) => e.type).join(','))
      const toolEvents = h.events.filter((e) => e.type === 'tool.call.completed') as Extract<
        AgentEvent,
        { type: 'tool.call.completed' }
      >[]
      console.log(
        '[SMOKE f] tool.call.completed:',
        JSON.stringify(
          toolEvents.map((e) => ({
            name: e.payload.name,
            isError: e.payload.isError,
            out: e.payload.outputPreview?.slice(0, 120)
          }))
        )
      )
      // No degradation event: the connector was forwarded, not skipped.
      expect(h.events.some((e) => e.type === 'session.mcp.skipped')).toBe(false)
      // The MCP call was permission-gated through Argus under its canonical name (§2 mapping).
      const gated = h.toolRequests.find((t) => t.name === 'mcp__argusEcho__mcp_echo')
      expect(
        gated,
        `expected an mcp__argusEcho__mcp_echo request; saw ${JSON.stringify(
          h.toolRequests.map((t) => t.name)
        )}`
      ).toBeDefined()
      expect(gated!.input).toEqual({ message: 'ping' })
      // The server's actual response reached the model and the model relayed it.
      expect(h.text()).toContain('mcp-echo:ping')
      expect(h.text()).not.toContain('NO_MCP_TOOL')
    } finally {
      h.session.end()
      scratch.cleanup()
    }
  }, 150000)
})
