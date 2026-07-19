import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSdkMessage } from '../normalize'
import { initialState, reduce } from '../../../../observability/reducer'
import type { AgentEvent } from '../../../../../../shared/agent-events'
import type { ObservationIntent } from '../../../../observability/intent'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__')
const ctx = { caseId: 1, caseSlug: 'NAV-1', sessionId: 7, turnId: 3 }

/** Raw SDK messages exactly as captured from a live turn. */
function loadMessages(fixture: string): unknown[] {
  return fs
    .readFileSync(path.join(FIXTURES, fixture), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

/**
 * Replays a captured SDK turn through the SAME chain production uses:
 * normalize -> the driver's tool-name backfill -> the observability reducer.
 *
 * Hand-built messages can only prove the code does what its author expected. This
 * proves it against bytes the SDK actually emitted — including the awkward parts
 * (top-level tool_use arriving twice, sub-agent tool_use arriving only in finished
 * messages) that were discovered by capture rather than by reading the types.
 */
function replay(fixture: string): {
  events: AgentEvent[]
  intents: ObservationIntent[]
} {
  const events: AgentEvent[] = []
  // Mirrors app/src/main/services/agent/drivers/claude/index.ts's stream loop.
  const toolNames = new Map<string, string>()
  for (const msg of loadMessages(fixture)) {
    for (const ev of normalizeSdkMessage(msg, ctx)) {
      if (ev.type === 'tool.call.started') toolNames.set(ev.payload.toolCallId, ev.payload.name)
      if (ev.type === 'tool.call.completed' && !ev.payload.name) {
        ev.payload.name = toolNames.get(ev.payload.toolCallId) ?? ''
      }
      events.push(ev)
    }
  }

  // Real event timestamps are absent from the capture (they are stamped by the
  // harness, not the SDK), so synthesise a monotonic clock: the reducer derives
  // durations from `ts`, and equal timestamps would mask a duration regression.
  let tick = 0
  let state = initialState()
  const intents: ObservationIntent[] = []
  for (const ev of events) {
    const stamped = { ...ev, ts: new Date(Date.UTC(2026, 6, 19, 0, 0, tick++)).toISOString() }
    const [next, produced] = reduce(state, stamped as AgentEvent, { captureContent: false })
    state = next
    intents.push(...produced)
  }
  return { events, intents }
}

describe('sub-agent tool calls, replayed from a captured SDK turn', () => {
  it('gives every completed tool call a name', () => {
    const { events } = replay('subagent-tool-calls.jsonl')
    const completed = events.filter((e) => e.type === 'tool.call.completed')
    expect(completed.length).toBeGreaterThan(0)
    expect(completed.filter((e) => !e.payload.name)).toEqual([])
  })

  it('names the sub-agent tools specifically, not just the top-level Task', () => {
    const { events } = replay('subagent-tool-calls.jsonl')
    const names = events
      .filter((e) => e.type === 'tool.call.completed')
      .map((e) => e.payload.name)
      .sort()
    // "Agent" is the top-level Task tool; PowerShell and Read are the sub-agent's.
    expect(names).toEqual(['Agent', 'PowerShell', 'Read'])
  })

  it('starts each top-level tool exactly once despite tool_use arriving twice', () => {
    const { events } = replay('subagent-tool-calls.jsonl')
    const starts = events.filter((e) => e.type === 'tool.call.started')
    const ids = starts.map((e) => e.payload.toolCallId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('produces a tool intent with a real duration for every tool, sub-agent included', () => {
    const { intents } = replay('subagent-tool-calls.jsonl')
    const tools = intents.filter((i) => i.kind === 'tool')
    expect(tools.map((t) => t.name).sort()).toEqual(['Agent', 'PowerShell', 'Read'])
    for (const t of tools) {
      expect(t.startTime, `${t.name} has no startTime`).toBeDefined()
      expect(t.endTime, `${t.name} has no endTime`).toBeDefined()
      expect(t.endTime! - t.startTime!, `${t.name} has non-positive duration`).toBeGreaterThan(0)
    }
  })
})
