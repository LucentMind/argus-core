import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createSession } from '../sessionStore'
import { createDetection } from '../../packs/detection'
import { caseDir } from '../../paths'
import { CaseSession, type SessionMirrorLike } from '../session'
import { CLAUDE_TOOL_TAXONOMY } from '../risk'
import { PERMISSION_MODES } from '../../../../shared/settings'
import type { AgentDriver, DriverSession, DriverSessionContext } from '../driver'
import type { AgentEvent } from '../../../../shared/agent-events'

/**
 * A driver that records what CaseSession actually handed the provider. The digest lives on
 * exactly this wire and nowhere else, so `sent` is the only place it may appear.
 */
function recordingDriver(): {
  driver: AgentDriver
  sent: string[]
  ctx: () => DriverSessionContext
} {
  const sent: string[] = []
  let captured: DriverSessionContext | null = null
  const driver: AgentDriver = {
    kind: 'claude-agent-sdk',
    toolTaxonomy: CLAUDE_TOOL_TAXONOMY,
    authFixHint: 'stub',
    capabilities: {
      permissionModes: PERMISSION_MODES,
      editableApprovals: true,
      costReporting: true,
      headlessOneShot: false,
      systemPromptTransport: 'systemPrompt.append',
      subagents: 'configurable',
      branching: 'native'
    },
    // The context is captured, not ignored: `onCursor`/`onTurnResult` are how a real driver
    // tells CaseSession a turn landed, and the replay seam now keys on exactly that.
    createSession(ctx: DriverSessionContext): DriverSession {
      captured = ctx
      return {
        // Never yields and never ends: this suite only inspects the send path.
        events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }),
        send: (text: string) => void sent.push(text),
        interrupt: async () => {},
        end: () => {}
      } as DriverSession
    },
    probeAuth: async () => ({ ok: true, detail: 'stub' })
  }
  return {
    driver,
    sent,
    ctx: () => {
      if (!captured) throw new Error('createSession was never called')
      return captured
    }
  }
}

const TURN_OK = {
  isError: false,
  inputTokens: 1,
  outputTokens: 1,
  costUsd: 0,
  durationMs: 1,
  model: 'm',
  authFailure: false
}

const ev = (type: string, payload: Record<string, unknown>): AgentEvent =>
  ({ type, payload }) as unknown as AgentEvent

let tmp: string, argusHome: string, db: DatabaseSync
let events: AgentEvent[]
let indexed: Array<{ role: string; content: string }>
let mirrored: AgentEvent[]
let sessionId: number
let caseId: number

const mirror = (): SessionMirrorLike => ({
  append: (e) => void mirrored.push(e),
  indexText: (role, content) => void indexed.push({ role, content })
})

/** Two turns of prior conversation, on disk where an imported case would leave them. */
function writeMirrorFile(): void {
  const dir = path.join(caseDir(argusHome, 'NAV-1'), 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  const lines = [
    ev('turn.started', { userText: 'earlier question' }),
    ev('assistant.message', { text: 'earlier answer' }),
    ev('turn.started', { userText: 'second earlier question' }),
    ev('assistant.message', { text: 'second earlier answer' })
  ].map((e) => JSON.stringify(e))
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`)
}

/** A turn that succeeded: the driver reports its cursor, then the turn result. */
function completeTurn(ctx: DriverSessionContext, cursor: string): void {
  ctx.onCursor(cursor)
  ctx.onTurnResult(TURN_OK)
}

/** A turn that failed before the provider ever produced a cursor — auth, spawn, interrupt. */
function failTurn(ctx: DriverSessionContext): void {
  ctx.onTurnResult({ ...TURN_OK, isError: true })
}

function makeSession(over: { resumeCursor: string | null }): {
  session: CaseSession
  sent: string[]
  ctx: () => DriverSessionContext
} {
  const { driver, sent, ctx } = recordingDriver()
  const session = new CaseSession({
    db,
    argusHome,
    detection: createDetection(),
    caseId,
    caseSlug: 'NAV-1',
    sessionId,
    workspaceRoots: [],
    skillsRoots: [],
    emit: (e) => events.push(e),
    driver,
    mirror: mirror(),
    githubWatermark: () => ({ enabled: false, text: '' }),
    ...over
  })
  return { session, sent, ctx }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-hist-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  caseId = createCase(db, argusHome, { slug: 'NAV-1', title: 't' }).id
  sessionId = createSession(db, 'NAV-1', 'claude-agent-sdk').id
  events = []
  indexed = []
  mirrored = []
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('CaseSession first-turn history replay', () => {
  it('prefixes the first send to the driver with a digest of the imported transcript', () => {
    writeMirrorFile()
    const { session, sent } = makeSession({ resumeCursor: null })
    session.send('what now?')
    expect(sent[0]).toContain('earlier question')
    expect(sent[0]).toContain('second earlier answer')
    expect(sent[0]).toContain('prior-conversation-record')
    expect(sent[0].endsWith('what now?')).toBe(true)
  })

  // The whole point of the task: the digest goes to the driver and to nothing that is
  // recorded. In the mirror it would render in the transcript AND be re-exported into the
  // next bundle (replaying a replay); in the title every imported chat is named after the
  // preamble; in indexText it pollutes chat search.
  it('keeps the digest out of the transcript, the title and the FTS index', () => {
    writeMirrorFile()
    const { session, sent } = makeSession({ resumeCursor: null })
    session.send('what now?')
    expect(sent[0]).not.toBe('what now?') // guard: the split is only meaningful if it fired

    const started = events.find((e) => e.type === 'turn.started') as
      { payload: { userText: string } } | undefined
    expect(started?.payload.userText).toBe('what now?')

    const mirroredStart = mirrored.find((e) => e.type === 'turn.started') as
      { payload: { userText: string } } | undefined
    expect(mirroredStart?.payload.userText).toBe('what now?')

    expect(indexed).toEqual([{ role: 'user', content: 'what now?' }])

    const row = db.prepare(`SELECT title FROM sessions WHERE id = ?`).get(sessionId) as {
      title: string
    }
    expect(row.title).toBe('what now?')
  })

  // The seam asks whether a usable cursor exists NOW, so a turn that actually landed one — the
  // driver's `onCursor` writes it — is what stops the replay, not the turn counter.
  it('does not replay once a turn has produced a resume cursor', () => {
    writeMirrorFile()
    const { session, sent, ctx } = makeSession({ resumeCursor: null })
    session.send('first')
    completeTurn(ctx(), 'cursor-from-turn-1')
    session.send('second')
    expect(sent[1]).toBe('second')
  })

  /**
   * The defect the turnIndex proxy had: turn 1 failing on auth, spawn or an interrupt never
   * reaches `onCursor`, so `driver_cursor` is still NULL — but `turnIndex` has already moved
   * past 0, so turn 2 used to get neither a digest nor a resume and the imported history was
   * lost for good, silently. The replay must survive a failed first turn.
   */
  it('replays again when the first turn failed without landing a cursor', () => {
    writeMirrorFile()
    const { session, sent, ctx } = makeSession({ resumeCursor: null })
    session.send('first')
    expect(sent[0]).toContain('earlier question') // guard: turn 1 did carry the digest
    failTurn(ctx())
    session.send('second')
    expect(sent[1]).toContain('earlier question')
    expect(sent[1]).toContain('prior-conversation-record')
    expect(sent[1].endsWith('second')).toBe(true)
  })

  it('does not replay when the session has a usable cursor', () => {
    writeMirrorFile()
    // Both halves of "usable": the row carries the cursor AND this session was constructed
    // with it, which is what a genuine resume looks like.
    db.prepare(`UPDATE sessions SET driver_cursor = ? WHERE id = ?`).run('abc-uuid', sessionId)
    const { session, sent } = makeSession({ resumeCursor: 'abc-uuid' })
    session.send('hello')
    expect(sent[0]).toBe('hello')
  })

  // Codex/ACP mint their cursor when the provider session is CREATED, not when a turn
  // succeeds, so a cursor can be in the row while the provider holds none of this
  // conversation. Until a turn completes, that cursor is not evidence of context.
  it('still replays when a cursor exists but no turn has completed on it', () => {
    writeMirrorFile()
    db.prepare(`UPDATE sessions SET driver_cursor = ? WHERE id = ?`).run('spawn-cursor', sessionId)
    const { session, sent } = makeSession({ resumeCursor: null })
    session.send('hello')
    expect(sent[0]).toContain('earlier question')
  })

  it('sends unprefixed when the mirror is missing', () => {
    const { session, sent } = makeSession({ resumeCursor: null })
    session.send('hello')
    expect(sent[0]).toBe('hello')
  })

  // A send must never fail because history could not be read. A directory where the mirror
  // file should be makes the read throw (EISDIR) rather than return [].
  it('sends unprefixed when reading the mirror throws', () => {
    fs.mkdirSync(path.join(caseDir(argusHome, 'NAV-1'), 'sessions', `${sessionId}.jsonl`), {
      recursive: true
    })
    const { session, sent } = makeSession({ resumeCursor: null })
    expect(() => session.send('hello')).not.toThrow()
    expect(sent[0]).toBe('hello')
  })
})
