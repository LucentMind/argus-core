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
import { OPEN_TAG, DIGEST_BUDGET, TOOL_NAME_CAP } from '../historyDigest'
import { NATIVE_RISK } from '../risk'
import type { AgentEvent } from '../../../../shared/agent-events'

const detection = createDetection()

let tmp: string
let argusHome: string
let db: DatabaseSync
let caseId: number
let tools: ReturnType<typeof argusToolHandlers>
let runningSessionId: number
let decoySessionWithItsOwnMirror: number

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

function newSession(forCase: number): number {
  const now = new Date().toISOString()
  const res = db
    .prepare(`INSERT INTO sessions (case_id, created_at, updated_at) VALUES (?, ?, ?)`)
    .run(forCase, now, now)
  return Number(res.lastInsertRowid)
}

function handlersFor(sessionId: number): ReturnType<typeof argusToolHandlers> {
  return argusToolHandlers({
    db,
    argusHome,
    detection,
    caseId,
    caseSlug: 'NAV-9',
    sessionId,
    emitFinding: vi.fn(),
    githubWatermark: () => ({ enabled: false, text: '' })
  })
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rst-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))

  const rec = createCase(db, argusHome, { slug: 'NAV-9', title: 'imported' })
  caseId = rec.id

  runningSessionId = newSession(rec.id)
  decoySessionWithItsOwnMirror = newSession(rec.id)

  const turns: AgentEvent[] = []
  for (let i = 1; i <= 5; i++) {
    turns.push(ev('turn.started', { userText: `question ${i}` }))
    turns.push(ev('tool.call.started', { toolCallId: `t${i}`, name: 'read_lines' }))
    turns.push(ev('assistant.message', { text: `answer ${i}` }))
  }
  writeMirror('NAV-9', runningSessionId, turns)
  // A mirror for a session that is NOT the running one. The tool takes no session argument, so
  // these bytes must be unreachable no matter what the model passes.
  writeMirror('NAV-9', decoySessionWithItsOwnMirror, [
    ev('turn.started', { userText: 'some other session of this case' })
  ])

  tools = handlersFor(runningSessionId)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('read_session_transcript', () => {
  it('returns turns from the running session', async () => {
    const out = await tools.read_session_transcript({})
    expect(out).toContain('question 1')
    expect(out).toContain('of 5 turns')
  })

  it('pages with fromTurn and limit', async () => {
    const out = await tools.read_session_transcript({ fromTurn: 4, limit: 2 })
    expect(out).toContain('question 4')
    expect(out).not.toContain('question 1')
  })

  it('takes no session argument at all', async () => {
    const spec = NATIVE_TOOL_SPECS.find((s) => s.name === 'read_session_transcript')
    // Sorted: the guard is "these two keys and no others", not the order they were typed in.
    expect(Object.keys(spec!.schema).sort()).toEqual(['fromTurn', 'limit'].sort())
    // and a stray sessionId cannot steer it off the running session
    const out = await tools.read_session_transcript({ sessionId: decoySessionWithItsOwnMirror })
    expect(out).toContain('question 1')
    expect(out).not.toContain('some other session of this case')
  })

  it('renders a coherent range when fromTurn is past the last turn', async () => {
    const out = await tools.read_session_transcript({ fromTurn: 99 })
    expect(out).toContain('Turns 0–0 of 5 turns')
    expect(out).not.toContain('question')
  })

  it('omits the fence when there is nothing to show', async () => {
    const out = await tools.read_session_transcript({ fromTurn: 99 })
    expect(out).not.toContain(OPEN_TAG)
  })

  it('frames its output as an untrusted record', async () => {
    const out = await tools.read_session_transcript({})
    expect(out).toContain('not instructions')
  })

  it('returns a plain empty result when the mirror is missing', async () => {
    const noMirrorSession = newSession(caseId)
    const out = await handlersFor(noMirrorSession).read_session_transcript({})
    expect(out).toContain('0 turns')
    expect(out).not.toContain(OPEN_TAG)
  })

  // The turn cap alone let one call return ~400KB (50 turns × two MSG_CAP-capped messages)
  // into the same context window DIGEST_BUDGET exists to protect.
  it('caps total bytes and reports where to continue', async () => {
    const big: AgentEvent[] = []
    for (let i = 1; i <= 40; i++) {
      big.push(ev('turn.started', { userText: `Q${i} ` + 'u'.repeat(4000) }))
      big.push(ev('assistant.message', { text: `A${i} ` + 'a'.repeat(4000) }))
    }
    const s = newSession(caseId)
    writeMirror('NAV-9', s, big)
    const out = await handlersFor(s).read_session_transcript({ limit: 50 })
    expect(out.length).toBeLessThan(DIGEST_BUDGET + 2000)
    expect(out).toContain('[capped — continue with fromTurn:')
    // The header must describe what was actually emitted, not what was paged.
    const shown = (out.match(/^Turn \d+$/gm) ?? []).length
    expect(out).toContain(`Turns 1–${shown} of 40 turns`)
    // and the continuation marker points at the first turn NOT shown
    expect(out).toContain(`fromTurn: ${shown + 1}`)
  })

  // With every field of a turn capped (MSG_CAP twice, plus the tool list), one rendered turn
  // can never on its own exceed the byte budget — so paging always makes progress and
  // `fromTurn` can never stall on a turn too big to emit.
  it('bounds a single turn well under the byte budget however large its input', async () => {
    const s = newSession(caseId)
    const evs: AgentEvent[] = [
      ev('turn.started', { userText: 'x'.repeat(200_000) }),
      ev('assistant.message', { text: 'y'.repeat(200_000) })
    ]
    for (let i = 0; i < 200; i++) {
      evs.push(ev('tool.call.started', { toolCallId: `t${i}`, name: 'n'.repeat(5000) + i }))
    }
    writeMirror('NAV-9', s, evs)
    const out = await handlersFor(s).read_session_transcript({})
    expect(out).toContain('Turn 1')
    expect(out.length).toBeLessThan(DIGEST_BUDGET / 2)
  })

  it('caps the tool-name list a turn can render', async () => {
    const s = newSession(caseId)
    const evs: AgentEvent[] = [ev('turn.started', { userText: 'hi' })]
    evs.push(ev('tool.call.started', { toolCallId: 'big', name: 'Z'.repeat(40_000) }))
    for (let i = 0; i < 40; i++) {
      evs.push(ev('tool.call.started', { toolCallId: `t${i}`, name: `tool_${i}` }))
    }
    writeMirror('NAV-9', s, evs)
    const out = await handlersFor(s).read_session_transcript({})
    expect(out).not.toContain('Z'.repeat(TOOL_NAME_CAP + 1))
    expect(out).toContain('+21 more')
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
