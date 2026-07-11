import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../db'
import { SessionMirror, readSessionEvents } from '../mirror'
import type { AgentEvent } from '../../../../shared/agent-events'

const ev = (type: string): AgentEvent =>
  ({
    eventId: 'e1',
    caseId: 1,
    caseSlug: 'NAV-1',
    sessionId: 1,
    turnId: 1,
    ts: new Date().toISOString(),
    type,
    payload: { text: 'x' }
  }) as unknown as AgentEvent

describe('SessionMirror', () => {
  it('appends events as JSONL (write-behind) and flushes on close', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-mir-'))
    const db = openDb(path.join(tmp, 'a.db'))
    const file = path.join(tmp, 'sessions', 's1.jsonl')
    const m = new SessionMirror(db, file, { caseId: 1, sessionId: 1 })
    m.append(ev('content.delta'))
    m.append(ev('turn.completed'))
    m.close()
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).type).toBe('content.delta')
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('readSessionEvents replays a single session file back, skipping corrupt lines', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-mir-'))
    const db = openDb(path.join(tmp, 'a.db'))
    const caseDir = path.join(tmp, 'case')
    const m = new SessionMirror(db, path.join(caseDir, 'sessions', '1.jsonl'), {
      caseId: 1,
      sessionId: 1
    })
    m.append(ev('turn.started'))
    m.append(ev('assistant.message'))
    m.close()
    fs.appendFileSync(path.join(caseDir, 'sessions', '1.jsonl'), 'not-json\n')
    const events = readSessionEvents(caseDir, 1)
    expect(events.map((e) => e.type)).toEqual(['turn.started', 'assistant.message'])
    expect(readSessionEvents(path.join(tmp, 'missing'), 1)).toEqual([])
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('readSessionEvents reads only the requested session file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-mir-'))
    const dir = path.join(tmp, 'case')
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'sessions', '1.jsonl'),
      JSON.stringify({ type: 'turn.started', sessionId: 1 }) + '\n'
    )
    fs.writeFileSync(
      path.join(dir, 'sessions', '2.jsonl'),
      JSON.stringify({ type: 'turn.started', sessionId: 2 }) + '\n'
    )
    expect(readSessionEvents(dir, 2)).toHaveLength(1)
    expect(readSessionEvents(dir, 99)).toEqual([]) // deleted/missing file → empty, never throws
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('indexes message text into messages_fts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-mir-'))
    const db = openDb(path.join(tmp, 'a.db'))
    const m = new SessionMirror(db, path.join(tmp, 's.jsonl'), { caseId: 1, sessionId: 1 })
    m.indexText('assistant', 'The tile server returned 404', 3)
    const row = db
      .prepare(`SELECT content, role FROM messages_fts WHERE messages_fts MATCH 'tile'`)
      .get() as { content: string; role: string }
    expect(row.role).toBe('assistant')
    m.close()
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
