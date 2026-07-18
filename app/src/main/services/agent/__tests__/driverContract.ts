import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../db'
import { createDetection } from '../../packs/detection'
import type { AgentEvent } from '../../../../shared/agent-events'
import type { AgentDriver, DriverSessionContext } from '../driver'
import type { NativeToolDeps } from '../nativeTools'
import type { DatabaseSync } from 'node:sqlite'

/**
 * A driver-agnostic description of what a scripted backend should do for a single
 * session. The Claude driver's test file translates this into raw SDK-shaped messages;
 * a future Copilot driver would translate it into its own transport frames. The suite
 * itself never sees driver-specific message shapes — only this normalized script.
 */
export interface TransportScript {
  /** Text chunks streamed as content deltas before the turn completes. */
  content?: string[]
  /** If set, the backend attempts exactly one tool call mid-stream. It MUST route the
   *  attempt through the harness approval hook (`DriverSessionContext.onToolRequest`);
   *  for Claude that means invoking the options bag's `canUseTool`. It emits a tool
   *  result only if the decision is `allow` — a deny short-circuits execution. */
  toolCall?: { name: string; input: Record<string, unknown> }
  /** A durable resume checkpoint the backend advertises (→ `onCursor`). */
  checkpoint?: string
  /** If true, the backend throws mid-stream instead of completing the turn. */
  throwMidStream?: boolean
  /** If true, the backend completes the turn (→ `turn.completed` + `onTurnResult`). */
  completeTurn?: boolean
}

/** The known `AgentEvent` union discriminants — invariant 1 validates against this. */
const KNOWN_EVENT_TYPES = new Set<AgentEvent['type']>([
  'session.started',
  'session.exited',
  'session.error',
  'turn.started',
  'turn.completed',
  'content.delta',
  'assistant.message',
  'tool.call.started',
  'tool.call.completed',
  'request.opened',
  'request.resolved',
  'case.finding.added',
  'case.evidence.ingested',
  'session.mcp.skipped'
])

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

/**
 * The shared driver-contract suite. Every `AgentDriver` implementation must satisfy these
 * six invariants when wired to a scripted transport.
 *
 * @param makeDriver Produces a driver bound to a scripted transport enacting the script
 *   most recently set via `setScript`. Called once per test, after `setScript`.
 * @param setScript Programs the scripted transport for the next session (the brief's
 *   "makeScriptedTransport"). The test file shares closure state between the two.
 */
export function runDriverContractSuite(
  makeDriver: () => AgentDriver,
  setScript: (script: TransportScript) => void
): void {
  describe('AgentDriver contract', () => {
    let tmp: string, argusHome: string, db: DatabaseSync

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-contract-'))
      argusHome = path.join(tmp, 'home')
      db = openDb(path.join(argusHome, 'argus.db'))
    })
    afterEach(() => {
      db.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    })

    const nativeDeps = (): NativeToolDeps => ({
      db,
      argusHome,
      detection: createDetection(),
      caseId: 1,
      caseSlug: 'c',
      sessionId: 1,
      emitFinding: () => {}
    })

    const makeCtx = (overrides: Partial<DriverSessionContext> = {}): DriverSessionContext => ({
      caseDir: tmp,
      additionalDirectories: [],
      permissionMode: 'default',
      systemAppend: 'CONTRACT',
      extraMcpServers: {},
      nativeToolDeps: nativeDeps(),
      panelCommandDecls: [],
      resumeCursor: null,
      eventCtx: () => ({ caseId: 1, caseSlug: 'c', sessionId: 1, turnId: 1 }),
      onToolRequest: async () => ({ behavior: 'allow', updatedInput: {} }),
      onCursor: vi.fn(),
      onTurnResult: vi.fn(),
      ...overrides
    })

    // 1. events() yields only valid AgentEvent union members.
    it('yields only well-formed AgentEvent union members', async () => {
      setScript({
        checkpoint: '11111111-1111-4111-8111-111111111111',
        content: ['hel', 'lo'],
        completeTurn: true
      })
      const session = makeDriver().createSession(makeCtx())
      session.send('go')
      const events: AgentEvent[] = []
      for await (const e of session.events()) events.push(e)
      expect(events.length).toBeGreaterThan(0)
      for (const e of events) {
        expect(KNOWN_EVENT_TYPES.has(e.type)).toBe(true)
        expect(e.payload).toBeTypeOf('object')
        expect(e.payload).not.toBeNull()
      }
    })

    // 2. Ordering: no content.delta before the first send(); turn.completed follows content.
    it('emits no content before send(), and completes the turn after its content', async () => {
      setScript({ content: ['streamed'], completeTurn: true })
      const session = makeDriver().createSession(makeCtx())
      const seen: AgentEvent['type'][] = []
      const drained = (async () => {
        for await (const e of session.events()) seen.push(e.type)
      })()
      // Before any send(), the transport has produced no content.
      await tick()
      expect(seen).not.toContain('content.delta')

      session.send('go')
      await drained
      const firstDelta = seen.indexOf('content.delta')
      const completed = seen.indexOf('turn.completed')
      expect(firstDelta).toBeGreaterThanOrEqual(0)
      expect(completed).toBeGreaterThan(firstDelta)
    })

    // 3. onToolRequest round-trip: a scripted tool call triggers exactly one request; a
    //    deny yields no tool execution and the stream continues to completion.
    it('routes a scripted tool call through onToolRequest exactly once; deny halts execution but not the stream', async () => {
      const onToolRequest = vi.fn(async () => ({
        behavior: 'deny' as const,
        message: 'contract-deny'
      }))
      setScript({
        toolCall: { name: 'Bash', input: { command: 'rm -rf /' } },
        completeTurn: true
      })
      const session = makeDriver().createSession(makeCtx({ onToolRequest }))
      session.send('go')
      const events: AgentEvent[] = []
      for await (const e of session.events()) events.push(e)
      expect(onToolRequest).toHaveBeenCalledTimes(1)
      // Denied → the backend emitted no tool result → no tool.call.completed.
      expect(events.some((e) => e.type === 'tool.call.completed')).toBe(false)
      // The stream continued past the denied call to its normal completion.
      expect(events.some((e) => e.type === 'turn.completed')).toBe(true)
    })

    // 4. onCursor fires with a non-empty string for a resumable checkpoint, and the value
    //    round-trips into a new session's resumeCursor without throwing.
    it('reports a resumable checkpoint that round-trips into a new session', async () => {
      const onCursor = vi.fn()
      setScript({ checkpoint: '22222222-2222-4222-8222-222222222222', completeTurn: true })
      const driver = makeDriver()
      const session = driver.createSession(makeCtx({ onCursor }))
      session.send('go')
      for await (const _ of session.events()) void _
      expect(onCursor).toHaveBeenCalled()
      const cursor = onCursor.mock.calls[0][0] as string
      expect(typeof cursor).toBe('string')
      expect(cursor.length).toBeGreaterThan(0)

      // The observed cursor is a valid resumeCursor for a fresh session.
      setScript({ completeTurn: true })
      expect(() => makeDriver().createSession(makeCtx({ resumeCursor: cursor }))).not.toThrow()
    })

    // 5. A transport that throws mid-stream ends events() (no hang). The harness — not the
    //    suite — owns emitting session.error, so we only assert termination here.
    it('propagates a mid-stream transport failure out of events() without hanging', async () => {
      setScript({ throwMidStream: true })
      const session = makeDriver().createSession(makeCtx())
      session.send('go')
      await expect(
        (async () => {
          for await (const _ of session.events()) void _
        })()
      ).rejects.toThrow()
    })

    // 6. interrupt() resolves even when the transport ignores it.
    it('resolves interrupt() even when the transport ignores it', async () => {
      setScript({ content: ['x'], completeTurn: true })
      const session = makeDriver().createSession(makeCtx())
      await expect(session.interrupt()).resolves.toBeUndefined()
    })
  })
}
