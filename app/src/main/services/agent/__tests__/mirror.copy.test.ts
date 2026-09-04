import { it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copySessionMirror, readSessionEvents } from '../mirror'
import type { AgentEvent } from '../../../../shared/agent-events'

it('copies only mapped turns, remaps ids, drops session.started, mints fresh eventIds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-mirror-copy-'))
  const ev = (turnId: number | null, type: string, payload: unknown): AgentEvent =>
    ({
      eventId: `e-${turnId}-${type}`,
      caseId: 1,
      caseSlug: 'A',
      sessionId: 5,
      turnId,
      ts: 't',
      type,
      payload
    }) as AgentEvent
  const src: AgentEvent[] = [
    ev(null, 'session.started', { model: 'm', resumed: false, effectivePermissionMode: null }),
    ev(10, 'turn.started', { userText: 'one' }),
    ev(10, 'assistant.message', { text: 'a1' }),
    ev(11, 'turn.started', { userText: 'two' }),
    ev(12, 'turn.started', { userText: 'three' })
  ]
  fs.mkdirSync(path.join(dir, 'sessions'))
  fs.writeFileSync(
    path.join(dir, 'sessions', '5.jsonl'),
    src.map((e) => JSON.stringify(e)).join('\n') + '\n'
  )
  const n = copySessionMirror(
    dir,
    5,
    9,
    new Map([
      [10, 100],
      [11, 101]
    ]),
    { caseId: 1, caseSlug: 'A' }
  )
  const out = readSessionEvents(dir, 9)
  expect(n).toBe(3)
  expect(out.map((e) => [e.type, e.turnId, e.sessionId])).toEqual([
    ['turn.started', 100, 9],
    ['assistant.message', 100, 9],
    ['turn.started', 101, 9]
  ])
  expect(new Set(out.map((e) => e.eventId)).size).toBe(3)
  expect(out.some((e) => src.some((s) => s.eventId === e.eventId))).toBe(false)
})
