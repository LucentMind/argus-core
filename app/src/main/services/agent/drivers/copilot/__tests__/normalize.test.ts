import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCopilotNormalizer, type RawSdkEvent } from '../normalize'
import type { AgentEvent } from '../../../../../../shared/agent-events'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__')
const ctx = { caseId: 1, caseSlug: 'NAV-1', sessionId: 7, turnId: 3 }

/** Load the raw `session.on(...)` SDK events from a captured `.jsonl` fixture. Each line is
 *  an envelope `{scenario,t,kind,data}`; `kind:"event"` lines carry a raw SDK payload. */
function loadEvents(fixture: string): RawSdkEvent[] {
  const text = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8')
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((o) => o.kind === 'event')
    .map((o) => o.data as RawSdkEvent)
}

/** Fold every raw event through a fresh normalizer, collecting the emitted AgentEvents. */
function normalizeFixture(
  fixture: string,
  init: { resumed: boolean; model: string } = { resumed: false, model: 'auto' }
): AgentEvent[] {
  const norm = createCopilotNormalizer(init)
  const out: AgentEvent[] = []
  for (const raw of loadEvents(fixture)) out.push(...norm.normalize(raw, ctx))
  return out
}

const types = (evs: AgentEvent[]): string[] => evs.map((e) => e.type)

describe('copilot normalize — fixture replay', () => {
  it('01-chat: session.started → content.delta → assistant.message → turn.completed', () => {
    const evs = normalizeFixture('01-chat.jsonl')
    expect(types(evs)).toEqual([
      'session.started',
      'content.delta',
      'assistant.message',
      'turn.completed'
    ])

    const started = evs[0]
    expect(started.type).toBe('session.started')
    if (started.type === 'session.started') expect(started.payload.resumed).toBe(false)

    const delta = evs[1]
    if (delta.type === 'content.delta') expect(delta.payload.text).toBe('OK')

    const msg = evs[2]
    if (msg.type === 'assistant.message') expect(msg.payload.text).toBe('OK')

    // Usage → turn accounting: real tokens, cost always null (costReporting:false), duration.
    const done = evs[3]
    if (done.type === 'turn.completed') {
      expect(done.payload.status).toBe('success')
      expect(done.payload.inputTokens).toBe(9482)
      expect(done.payload.outputTokens).toBe(100)
      expect(done.payload.costUsd).toBeNull()
      expect(done.payload.durationMs).toBe(2049)
    }
  })

  it('01-chat: turnResult records the RESOLVED model + tokens, cost null', () => {
    const norm = createCopilotNormalizer({ resumed: false, model: 'auto' })
    for (const raw of loadEvents('01-chat.jsonl')) {
      if (norm.turnBoundary(raw) === 'success') {
        const r = norm.turnResult()
        expect(r.model).toBe('gpt-5-mini') // resolved from turn_start/usage, not "auto"
        expect(r.inputTokens).toBe(9482)
        expect(r.outputTokens).toBe(100)
        expect(r.costUsd).toBeNull()
        expect(r.authFailure).toBe(false)
      }
      norm.normalize(raw, ctx)
    }
  })

  it('07-resume: session.started(resumed) then two normalized turns', () => {
    const evs = normalizeFixture('07-resume.jsonl', { resumed: true, model: 'auto' })
    expect(types(evs)).toEqual([
      'session.started',
      'content.delta',
      'assistant.message',
      'turn.completed',
      'content.delta',
      'assistant.message',
      'turn.completed'
    ])
    const started = evs[0]
    if (started.type === 'session.started') expect(started.payload.resumed).toBe(true)
    // Second turn recalled prior context ("banana") — history continuity.
    const secondMsg = evs[5]
    if (secondMsg.type === 'assistant.message') expect(secondMsg.payload.text).toBe('banana')
  })

  it('10-auth-failure: session.started → session.error, and authErrorResult flags auth', () => {
    const evs = normalizeFixture('10-auth-failure.jsonl')
    expect(types(evs)).toEqual(['session.started', 'session.error'])
    const err = evs[1]
    if (err.type === 'session.error') {
      expect(err.payload.message).toContain('Session was not created with authentication info')
    }

    // The typed session.error yields an auth-failure TurnResult for the harness.
    const norm = createCopilotNormalizer({ resumed: false, model: 'auto' })
    const authRaw = loadEvents('10-auth-failure.jsonl').find((r) => r.type === 'session.error')!
    const r = norm.authErrorResult(authRaw)
    expect(r).not.toBeNull()
    expect(r!.authFailure).toBe(true)
    expect(r!.isError).toBe(true)
  })

  it('11-interrupt: abort → turn.completed(interrupted)', () => {
    const evs = normalizeFixture('11-interrupt.jsonl')
    expect(types(evs)).toEqual(['session.started', 'turn.completed'])
    const done = evs[1]
    if (done.type === 'turn.completed') expect(done.payload.status).toBe('interrupted')

    // The abort event is a turn boundary that yields an interrupted (non-error) TurnResult.
    const norm = createCopilotNormalizer({ resumed: false, model: 'auto' })
    const abortRaw = loadEvents('11-interrupt.jsonl').find((r) => r.type === 'abort')!
    expect(norm.turnBoundary(abortRaw)).toBe('interrupted')
    expect(norm.turnResult().isError).toBe(false)
  })

  it('12-plan-mode: mode_changed ignored; three tool turns normalize cleanly', () => {
    const norm = createCopilotNormalizer({ resumed: false, model: 'auto' })
    // mode_changed maps to nothing (v1 minimal — plan mode is 9B territory).
    expect(norm.normalize({ type: 'session.mode_changed', data: {} }, ctx)).toEqual([])

    const evs = normalizeFixture('12-plan-mode.jsonl')
    const t = types(evs)
    expect(t[0]).toBe('session.started')
    expect(t.filter((x) => x === 'turn.completed')).toHaveLength(3)
    expect(t.filter((x) => x === 'tool.call.started')).toHaveLength(4)
    expect(t.filter((x) => x === 'tool.call.completed')).toHaveLength(4)
    expect(t).not.toContain('session.error')
    // Only known union members are emitted.
    const allowed = new Set([
      'session.started',
      'content.delta',
      'assistant.message',
      'tool.call.started',
      'tool.call.completed',
      'turn.completed'
    ])
    for (const x of t) expect(allowed.has(x)).toBe(true)
  })
})
