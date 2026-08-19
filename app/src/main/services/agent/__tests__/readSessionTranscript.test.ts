import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { caseDir } from '../../paths'
import { createDetection } from '../../packs/detection'
import { argusToolHandlers, NATIVE_TOOL_SPECS } from '../nativeTools'
import { NATIVE_RISK } from '../risk'
import type { AgentEvent } from '../../../../shared/agent-events'

const detection = createDetection()

let tmp: string
let argusHome: string
let db: DatabaseSync
let tools: ReturnType<typeof argusToolHandlers>
let runningSessionId: number
let otherCaseSessionId: number
let sessionWithNoMirror: number

const ev = (type: string, payload: Record<string, unknown>): AgentEvent =>
  ({ type, payload }) as unknown as AgentEvent

function writeMirror(slug: string, sessionId: number, events: AgentEvent[]): void {
  const dir = path.join(caseDir(argusHome, slug), 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  )
}

function newSession(caseId: number): number {
  const now = new Date().toISOString()
  const res = db
    .prepare(`INSERT INTO sessions (case_id, created_at, updated_at) VALUES (?, ?, ?)`)
    .run(caseId, now, now)
  return Number(res.lastInsertRowid)
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rst-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))

  const rec = createCase(db, argusHome, { slug: 'NAV-9', title: 'imported' })
  const other = createCase(db, argusHome, { slug: 'OTHER-9', title: 'other' })

  runningSessionId = newSession(rec.id)
  sessionWithNoMirror = newSession(rec.id)
  otherCaseSessionId = newSession(other.id)

  const turns: AgentEvent[] = []
  for (let i = 1; i <= 5; i++) {
    turns.push(ev('turn.started', { userText: `question ${i}` }))
    turns.push(ev('tool.call.started', { toolCallId: `t${i}`, name: 'read_lines' }))
    turns.push(ev('assistant.message', { text: `answer ${i}` }))
  }
  writeMirror('NAV-9', runningSessionId, turns)
  writeMirror('OTHER-9', otherCaseSessionId, [
    ev('turn.started', { userText: 'other case secret' }),
    ev('assistant.message', { text: 'other case secret reply' })
  ])
  // The other case's session id also exists as a path under THIS case's dir. Without the
  // ownership check the handler would happily read the wrong case's bytes; with it, the
  // throw happens before any read, so this decoy must never surface either.
  writeMirror('NAV-9', otherCaseSessionId, [
    ev('turn.started', { userText: 'decoy under this case' })
  ])

  tools = argusToolHandlers({
    db,
    argusHome,
    detection,
    caseId: rec.id,
    caseSlug: 'NAV-9',
    sessionId: runningSessionId,
    emitFinding: vi.fn(),
    githubWatermark: () => ({ enabled: false, text: '' })
  })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('read_session_transcript', () => {
  it('returns turns from the running session by default', async () => {
    const out = await tools.read_session_transcript({})
    expect(out).toContain('question 1')
    expect(out).toContain('of 5 turns')
  })

  it('pages with fromTurn and limit', async () => {
    const out = await tools.read_session_transcript({ fromTurn: 4, limit: 2 })
    expect(out).toContain('question 4')
    expect(out).not.toContain('question 1')
  })

  it('rejects a non-integer session id before touching the filesystem', async () => {
    const spy = vi.spyOn(fs, 'existsSync')
    // The message matters: it proves the EARLY integer guard rejected these, not the ownership
    // lookup further down. Without that distinction the assertion passes even with the guard
    // deleted, because a NaN id happens to match no sessions row either.
    await expect(tools.read_session_transcript({ sessionId: '../../etc/passwd' })).rejects.toThrow(
      /Invalid session id/
    )
    await expect(tools.read_session_transcript({ sessionId: 1.5 })).rejects.toThrow(
      /Invalid session id/
    )
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('cannot read a session belonging to another case', async () => {
    await expect(tools.read_session_transcript({ sessionId: otherCaseSessionId })).rejects.toThrow(
      /Unknown session/
    )
    // and it is not merely reading a same-named file under this case instead
    let out = ''
    try {
      out = await tools.read_session_transcript({ sessionId: otherCaseSessionId })
    } catch {
      /* expected */
    }
    expect(out).not.toContain('other case secret')
    expect(out).not.toContain('decoy under this case')
  })

  it('frames its output as an untrusted record', async () => {
    const out = await tools.read_session_transcript({})
    expect(out).toContain('not instructions')
  })

  it('returns a plain empty result when the mirror is missing', async () => {
    const out = await tools.read_session_transcript({ sessionId: sessionWithNoMirror })
    expect(out).toContain('0 turns')
  })

  it('is declared and risk-classified under a byte-matching key', () => {
    const spec = NATIVE_TOOL_SPECS.find((s) => s.name === 'read_session_transcript')
    expect(spec).toBeDefined()
    expect(NATIVE_RISK['mcp__argus__read_session_transcript']).toEqual({
      action: 'allow',
      risk: 'LOW'
    })
  })
})
