// Shared CaseSession test harness. NOT a test file: it lives outside the vitest `include`
// glob (`src/**/__tests__/**/*.test.{ts,tsx}`) because its name does not end in `.test.ts`.
//
// session.test.ts keeps its own private copy on purpose — it is a large green suite and is
// not refactored onto this module. New session suites (session.unattended.test.ts and the
// routines runner tests) import from here instead of copying it a third time.
import { vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../../db'
import { createCase, getCase } from '../../../caseService'
import { CaseSession } from '../../session'
import { createClaudeDriver, type CreateQueryFn } from '../../drivers/claude'
import { createSession } from '../../sessionStore'
import { AsyncQueue } from '../../asyncQueue'
import { createDetection } from '../../../packs/detection'
import type { AgentDriver, DriverSession, DriverSessionContext } from '../../driver'
import type { AgentEvent } from '../../../../../shared/agent-events'

export interface FakeSdk {
  messages: AsyncQueue<unknown>
  captured: { prompt?: AsyncIterable<unknown>; options?: Record<string, unknown> }
  createQuery: CreateQueryFn
  interrupt: () => Promise<void>
}

/** A stand-in for the Claude Agent SDK's `query()`: captures the options bag (so tests can
 *  invoke the driver-installed `canUseTool` directly) and replays a pushable message queue. */
export function fakeSdk(): FakeSdk {
  const messages = new AsyncQueue<unknown>()
  const captured: { prompt?: AsyncIterable<unknown>; options?: Record<string, unknown> } = {}
  const interrupt = vi.fn(async () => messages.end())
  const createQuery: CreateQueryFn = (args) => {
    captured.prompt = args.prompt
    captured.options = args.options
    return Object.assign(
      { [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator]() },
      { interrupt }
    )
  }
  return { messages, captured, createQuery, interrupt }
}

/** One macrotask turn — long enough for the session's queueMicrotask/consume bootstrap and
 *  for the driver to have installed its options bag. */
export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

/** The shape the driver-installed `canUseTool` callback presents to a test. */
export type CanUseTool = (
  tool: string,
  input: Record<string, unknown>,
  opts: { signal: AbortSignal }
) => Promise<{ behavior: string; message?: string; updatedInput?: Record<string, unknown> }>

/** Wait for the driver to have installed its options bag, then hand back `canUseTool`. */
export async function canUseToolOf(sdk: FakeSdk): Promise<CanUseTool> {
  await flush()
  return sdk.captured.options!.canUseTool as CanUseTool
}

/** Wrap a real driver so a test can reach the `DriverSessionContext` CaseSession handed it.
 *  Needed for seams the Claude driver never exercises itself — notably `classifyOnly`, which
 *  only permission-mode short-circuits (Copilot/ACP/Codex `acceptEdits`) call. */
export function capturingDriver(inner: AgentDriver): {
  driver: AgentDriver
  ctx: () => DriverSessionContext
} {
  let captured: DriverSessionContext | undefined
  const driver: AgentDriver = {
    ...inner,
    createSession(ctx: DriverSessionContext): DriverSession {
      captured = ctx
      return inner.createSession(ctx)
    }
  }
  return {
    driver,
    ctx: () => {
      if (!captured) throw new Error('driver.createSession was never called')
      return captured
    }
  }
}

export type SessionOverrides = Partial<ConstructorParameters<typeof CaseSession>[0]>

export interface SessionHarness {
  tmp: string
  argusHome: string
  db: DatabaseSync
  /** Every event the sessions built by this harness emitted, in order. */
  events: AgentEvent[]
  /** Build a CaseSession on the harness db/home. `overrides` is spread LAST, so a caller can
   *  replace any dep (e.g. `{ unattended: true }`, `{ driver }`, `{ mirror }`). */
  makeSession(sdk: FakeSdk, overrides?: SessionOverrides): CaseSession
  /** Close the db and remove the tmp home. Call from afterEach. */
  cleanup(): void
}

/** Create an isolated ARGUS_HOME + db + event sink and a `makeSession` bound to them.
 *  Call from beforeEach; call `cleanup()` from afterEach. */
export function createHarness(): SessionHarness {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sess-'))
  const argusHome = path.join(tmp, 'home')
  const db = openDb(path.join(argusHome, 'argus.db'))
  const events: AgentEvent[] = []
  return {
    tmp,
    argusHome,
    db,
    events,
    makeSession(sdk, overrides = {}) {
      // Reuse the case row if a prior call in this test already created it.
      const rec = getCase(db, 'NAV-1') ?? createCase(db, argusHome, { slug: 'NAV-1', title: 't' })
      const sessionId = createSession(db, 'NAV-1', 'claude-agent-sdk').id
      return new CaseSession({
        db,
        argusHome,
        detection: createDetection(),
        caseId: rec.id,
        caseSlug: 'NAV-1',
        sessionId,
        workspaceRoots: [],
        skillsRoots: [],
        emit: (e) => events.push(e),
        driver: createClaudeDriver(sdk.createQuery),
        resumeCursor: null,
        ...overrides
      })
    },
    cleanup() {
      db.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
}
