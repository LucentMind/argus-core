import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, getCase } from '../../caseService'
import { CaseSession } from '../session'
import { createClaudeDriver, type CreateQueryFn } from '../drivers/claude'
import { createSession } from '../sessionStore'
import { AsyncQueue } from '../asyncQueue'
import { createDetection } from '../../packs/detection'
import type { AgentEvent } from '../../../../shared/agent-events'

// Captures the options bag so the test can invoke the driver-installed canUseTool directly.
function fakeSdk(): {
  captured: { options?: Record<string, unknown> }
  createQuery: CreateQueryFn
} {
  const messages = new AsyncQueue<unknown>()
  const captured: { options?: Record<string, unknown> } = {}
  const createQuery: CreateQueryFn = (args) => {
    captured.options = args.options
    return Object.assign(
      { [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator]() },
      { interrupt: async () => messages.end() }
    )
  }
  return { captured, createQuery }
}

let home: string, db: DatabaseSync, events: AgentEvent[]

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-dlg-'))
  db = openDb(path.join(home, 'argus.db'))
  events = []
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

function makeSession(sdk: ReturnType<typeof fakeSdk>): CaseSession {
  const rec = getCase(db, 'NAV-1') ?? createCase(db, home, { slug: 'NAV-1', title: 't' })
  const sessionId = createSession(db, 'NAV-1', 'claude-agent-sdk').id
  return new CaseSession({
    db,
    argusHome: home,
    detection: createDetection(),
    caseId: rec.id,
    caseSlug: 'NAV-1',
    sessionId,
    workspaceRoots: [],
    skillsRoots: [],
    emit: (e) => events.push(e),
    driver: createClaudeDriver(sdk.createQuery),
    resumeCursor: null
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const canUseTool = (sdk: ReturnType<typeof fakeSdk>): any => sdk.captured.options!.canUseTool
const input = {
  questions: [
    {
      question: 'Which log first?',
      header: 'Order',
      multiSelect: false,
      options: [
        { label: 'Crash log', description: 'the stack trace' },
        { label: 'Network log', description: 'the request timeline' }
      ]
    }
  ]
}

describe('CaseSession AskUserQuestion pipeline', () => {
  it('opens a dialog and answers via allow + updatedInput.answers', async () => {
    const sdk = fakeSdk()
    const session = makeSession(sdk)
    const decisionP = canUseTool(sdk)('AskUserQuestion', input, {
      signal: new AbortController().signal
    })
    await new Promise((r) => setTimeout(r, 5))

    const opened = events.find((e) => e.type === 'dialog.opened')
    expect(opened).toBeDefined()
    expect(opened!.payload.questions[0]).toMatchObject({
      question: 'Which log first?',
      header: 'Order',
      multiSelect: false,
      options: [
        { label: 'Crash log', description: 'the stack trace' },
        { label: 'Network log', description: 'the request timeline' }
      ]
    })
    const dialogId = opened!.payload.dialogId

    expect(
      session.answerDialog({
        dialogId,
        behavior: 'completed',
        result: { answers: { 'Which log first?': 'Crash log' } }
      })
    ).toBe(true)

    await expect(decisionP).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: input.questions,
        answers: { 'Which log first?': 'Crash log' }
      }
    })
    expect(
      events.some((e) => e.type === 'dialog.resolved' && e.payload.behavior === 'completed')
    ).toBe(true)
    await session.stop('stopped')
  })

  it('a skip resolves to a clean allow carrying a freeform response (never a deny)', async () => {
    const sdk = fakeSdk()
    const session = makeSession(sdk)
    const decisionP = canUseTool(sdk)('AskUserQuestion', input, {
      signal: new AbortController().signal
    })
    await new Promise((r) => setTimeout(r, 5))
    const dialogId = events.find((e) => e.type === 'dialog.opened')!.payload.dialogId
    session.answerDialog({ dialogId, behavior: 'cancelled' })
    const decision = await decisionP
    expect(decision.behavior).toBe('allow')
    expect((decision as { updatedInput: { response?: string } }).updatedInput.response).toMatch(
      /dismissed/i
    )
    await session.stop('stopped')
  })

  it('drain cancels an in-flight dialog on stop', async () => {
    const sdk = fakeSdk()
    const session = makeSession(sdk)
    const decisionP = canUseTool(sdk)('AskUserQuestion', input, {
      signal: new AbortController().signal
    })
    await new Promise((r) => setTimeout(r, 5))
    await session.stop('stopped')
    const decision = await decisionP
    expect(decision.behavior).toBe('allow') // drained → cancelled → clean skip response
    await session.stop('stopped')
  })
})
