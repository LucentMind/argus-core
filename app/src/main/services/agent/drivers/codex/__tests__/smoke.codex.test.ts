import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../../../db'
import { createCase } from '../../../../caseService'
import { createDetection } from '../../../../packs/detection'
import { caseDir as caseDirOf } from '../../../../paths'
import { createCodexDriver } from '../index'
import { runCodexHeadless } from '../headless'
import { defaultCodexClientFactory } from '../client'
import type { AgentEvent } from '../../../../../../shared/agent-events'
import type { DriverSession, DriverSessionContext, ToolDecision, TurnResult } from '../../../driver'
import type { NativeToolDeps } from '../../../nativeTools'

/**
 * Real-runtime e2e smoke suite (Task 10). Gated behind CODEX_SMOKE so committed CI never
 * boots the real `codex app-server` binary or requires OpenAI/ChatGPT auth. Run manually with:
 *   CODEX_SMOKE=1 npx vitest run src/main/services/agent/drivers/codex/__tests__/smoke.codex.test.ts
 *
 * Mirrors the copilot driver's smoke suite (`drivers/copilot/__tests__/smoke.test.ts`):
 * scratch argusHome/case/db per scenario, a small harness collecting normalized events/turn
 * results/cursors, and every prompt kept minimal. Codex has no cost figure on the wire
 * (contract §7 — `costUsd` is always null by design), so the accounting assertion below checks
 * TOKEN counts, never cost.
 */

const SMOKE = Boolean(process.env.CODEX_SMOKE)

interface Scratch {
  argusHome: string
  caseDir: string
  db: DatabaseSync
  deps: NativeToolDeps
  cleanup: () => void
}

function makeScratch(slug = 'CODEX-SMOKE'): Scratch {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-smoke-'))
  const argusHome = path.join(root, 'home')
  fs.mkdirSync(argusHome, { recursive: true })
  const db = openDb(path.join(argusHome, 'argus.db'))
  const rec = createCase(db, argusHome, { slug, title: 'codex smoke' })
  const caseDir = caseDirOf(argusHome, slug)
  const deps: NativeToolDeps = {
    db,
    argusHome,
    detection: createDetection(),
    caseId: rec.id,
    caseSlug: slug,
    sessionId: 1,
    emitFinding: vi.fn(),
    currentTurnId: () => 1
  } as unknown as NativeToolDeps
  return {
    argusHome,
    caseDir,
    db,
    deps,
    cleanup: () => {
      try {
        db.close()
      } catch {
        /* already closed */
      }
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
  toolRequests: Array<{ name: string; input: Record<string, unknown> }>
  drained: Promise<void>
  turns(): number
  waitForTurns(n: number, timeoutMs: number): Promise<void>
  text(): string
}

function open(
  driver: ReturnType<typeof createCodexDriver>,
  scratch: Scratch,
  opts: {
    onToolRequest?: (name: string, input: Record<string, unknown>) => ToolDecision
  } = {}
): Harness {
  const events: AgentEvent[] = []
  const turnResults: TurnResult[] = []
  const toolRequests: Array<{ name: string; input: Record<string, unknown> }> = []

  const ctx: DriverSessionContext = {
    caseDir: scratch.caseDir,
    additionalDirectories: [],
    skills: [],
    subagents: [],
    permissionMode: 'default',
    systemAppend: '',
    extraMcpServers: {},
    nativeToolDeps: scratch.deps,
    panelCommandDecls: [],
    resumeCursor: null,
    eventCtx: () => ({ caseId: 1, caseSlug: scratch.deps.caseSlug, sessionId: 1, turnId: 1 }),
    onToolRequest: async (name, input) => {
      toolRequests.push({ name, input })
      return opts.onToolRequest
        ? opts.onToolRequest(name, input)
        : { behavior: 'deny', message: 'smoke: denied by default' }
    },
    onCursor: () => {},
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

  return { session, events, turnResults, toolRequests, drained, turns, waitForTurns, text }
}

describe.skipIf(!SMOKE)('codex driver — real runtime smoke (e2e)', () => {
  it('probeAuth reports authenticated against the real codex binary', async () => {
    const driver = createCodexDriver()
    const auth = await driver.probeAuth({ timeoutMs: 20000 })
    console.log('[SMOKE] probeAuth:', JSON.stringify(auth))
    expect(auth.ok).toBe(true)
  }, 60000)

  it('(a) exec + file patch: a scripted allow approves both, and turn.completed carries non-null token counts', async () => {
    const scratch = makeScratch('CODEX-A')
    const driver = createCodexDriver()
    const h = open(driver, scratch, {
      onToolRequest: () => ({ behavior: 'allow', updatedInput: {} })
    })
    try {
      h.session.send(
        'Run the shell command `echo hello-codex-smoke` and separately create a file named ' +
          'smoke-note.txt in the current directory with the exact contents `hello`. Use your ' +
          'real tools for both — do not just describe what you would do. Then reply DONE.'
      )
      await h.waitForTurns(1, 120000)
      h.session.end()
      await h.drained

      const completedCalls = h.events.filter((e) => e.type === 'tool.call.completed') as Extract<
        AgentEvent,
        { type: 'tool.call.completed' }
      >[]
      console.log('[SMOKE a] toolRequests:', JSON.stringify(h.toolRequests.map((t) => t.name)))
      console.log('[SMOKE a] event types:', h.events.map((e) => e.type).join(','))
      console.log(
        '[SMOKE a] completed:',
        JSON.stringify(
          completedCalls.map((e) => ({ name: e.payload.name, isError: e.payload.isError }))
        )
      )
      console.log('[SMOKE a] turnResult:', JSON.stringify(h.turnResults[0]))

      // Both an exec (shell) and a write (fileChange) request were routed through approval,
      // and both completed.
      expect(h.toolRequests.some((t) => t.name === 'shell')).toBe(true)
      expect(h.toolRequests.some((t) => t.name === 'write')).toBe(true)
      expect(completedCalls.some((e) => e.payload.name === 'shell')).toBe(true)
      expect(completedCalls.some((e) => e.payload.name === 'write')).toBe(true)
      expect(fs.existsSync(path.join(scratch.caseDir, 'smoke-note.txt'))).toBe(true)

      const completed = h.events.find((e) => e.type === 'turn.completed')
      expect(completed).toBeDefined()
      expect(h.events.some((e) => e.type === 'session.error')).toBe(false)
      // Codex reports usage via thread/tokenUsage/updated; costUsd is null by design
      // (contract §7 — no cost field anywhere on this wire), so assert TOKENS, not cost.
      const tr = h.turnResults[h.turnResults.length - 1]
      expect(tr.costUsd).toBeNull()
      expect(typeof tr.inputTokens).toBe('number')
      expect(tr.inputTokens).not.toBeNull()
      expect(typeof tr.outputTokens).toBe('number')
      expect(tr.outputTokens).not.toBeNull()
    } finally {
      h.session.end()
      scratch.cleanup()
    }
  }, 150000)

  it('(b) runCodexHeadless returns non-empty text for a one-shot prompt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-smoke-headless-'))
    try {
      const text = await runCodexHeadless(
        'Reply with exactly one short sentence confirming you received this message.',
        { argusHome: root, timeoutMs: 60000 },
        defaultCodexClientFactory
      )
      console.log('[SMOKE b] headless text:', JSON.stringify(text.slice(0, 300)))
      expect(text.length).toBeGreaterThan(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 90000)
})
