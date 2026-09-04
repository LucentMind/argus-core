import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../db'
import { createCase, getCase } from '../../caseService'
import { CaseSession } from '../session'
import { createClaudeDriver, type CreateQueryFn } from '../drivers/claude'
import { createSession } from '../sessionStore'
import { AsyncQueue } from '../asyncQueue'
import { createDetection } from '../../packs/detection'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent } from '../../../../shared/agent-events'

// Copied verbatim from session.test.ts:53-96 (fakeSdk + makeSession + flush) per the
// task-3 brief rather than importing — these are test-local wiring, not shared API.
interface FakeSdk {
  messages: AsyncQueue<unknown>
  captured: { prompt?: AsyncIterable<unknown>; options?: Record<string, unknown> }
  createQuery: CreateQueryFn
  interrupt: () => Promise<void>
}

function fakeSdk(): FakeSdk {
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

let tmp: string, argusHome: string, db: DatabaseSync
let events: AgentEvent[]

function makeSession(
  sdk: ReturnType<typeof fakeSdk>,
  overrides: Partial<ConstructorParameters<typeof CaseSession>[0]> = {}
): CaseSession {
  // Reuse the case row if a prior call in this test already created it — lets tests
  // create extra session rows for 'NAV-1' via sessionStore before calling makeSession.
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
    githubWatermark: () => ({ enabled: false, text: '' }),
    ...overrides
  })
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sess-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  events = []
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const SID = '11111111-1111-4111-8111-111111111111'

describe('CaseSession provider anchors', () => {
  it('writes the provider anchor id onto the turn row', async () => {
    const sdk = fakeSdk()
    const session = makeSession(sdk)
    session.send('hello')
    await flush()
    sdk.messages.push({ type: 'system', subtype: 'init', session_id: SID, model: 'm' })
    sdk.messages.push({
      type: 'assistant',
      uuid: 'a-9',
      session_id: SID,
      message: { content: [{ type: 'text', text: 'ok' }] }
    })
    sdk.messages.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: SID,
      uuid: 'r',
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
      duration_ms: 1
    })
    await flush()
    const row = db
      .prepare(`SELECT provider_anchor_id FROM turns WHERE session_id = ?`)
      .get(session.sessionId) as {
      provider_anchor_id: string | null
    }
    expect(row).toEqual({ provider_anchor_id: 'a-9' })
  })
})
