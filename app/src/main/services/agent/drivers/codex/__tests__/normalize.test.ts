import { describe, it, expect } from 'vitest'
import { createCodexNormalizer, type RawCodexNotification } from '../normalize'
import type { AgentEvent } from '../../../../../../shared/agent-events'

const ctx = { caseId: 1, caseSlug: 'NAV-1', sessionId: 7, turnId: 3 }

// All fixture objects below are copy-pasted (field-for-field) from the wire-contract
// doc's concrete examples (§5 streaming notifications, §6 multi-pass, §7 usage, §9 error).

const turnStarted = (turnId = 'turn-1'): RawCodexNotification => ({
  method: 'turn/started',
  params: { threadId: 'thread-1', turn: { id: turnId, status: 'inProgress' } }
})

const agentMessageDelta = (delta: string, itemId = 'item-1'): RawCodexNotification => ({
  method: 'item/agentMessage/delta',
  params: { delta, itemId, threadId: 'thread-1', turnId: 'turn-1' }
})

const agentMessageCompleted = (text: string, itemId = 'item-1'): RawCodexNotification => ({
  method: 'item/completed',
  params: {
    completedAtMs: 1732400000000,
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { type: 'agentMessage', id: itemId, text }
  }
})

const commandStarted = (itemId = 'item-3'): RawCodexNotification => ({
  method: 'item/started',
  params: {
    startedAtMs: 1732400000000,
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: {
      type: 'commandExecution',
      id: itemId,
      command: 'npm test',
      cwd: '/repo',
      status: 'inProgress'
    }
  }
})

const commandCompleted = (opts: {
  itemId?: string
  exitCode: number | null
  status: string
  aggregatedOutput?: string | null
}): RawCodexNotification => ({
  method: 'item/completed',
  params: {
    completedAtMs: 1732400000000,
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: {
      type: 'commandExecution',
      id: opts.itemId ?? 'item-3',
      command: 'npm test',
      cwd: '/repo',
      status: opts.status,
      exitCode: opts.exitCode,
      aggregatedOutput: opts.aggregatedOutput ?? null,
      durationMs: 4213
    }
  }
})

const fileChangeStarted = (itemId = 'item-4'): RawCodexNotification => ({
  method: 'item/started',
  params: {
    startedAtMs: 1732400000000,
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { type: 'fileChange', id: itemId, status: 'inProgress' }
  }
})

const fileChangeCompleted = (opts: {
  itemId?: string
  status: string
  changes?: Array<{ path: string; diff: string; kind: unknown }>
}): RawCodexNotification => ({
  method: 'item/completed',
  params: {
    completedAtMs: 1732400000000,
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: {
      type: 'fileChange',
      id: opts.itemId ?? 'item-4',
      status: opts.status,
      changes: opts.changes ?? [{ path: 'src/foo.ts', diff: '@@ ...', kind: { type: 'update' } }]
    }
  }
})

const patchUpdated = (itemId = 'item-4'): RawCodexNotification => ({
  method: 'item/fileChange/patchUpdated',
  params: {
    itemId,
    threadId: 'thread-1',
    turnId: 'turn-1',
    changes: [{ path: 'src/foo.ts', diff: '@@ ...', kind: { type: 'update' } }]
  }
})

const tokenUsageUpdated = (last: {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}): RawCodexNotification => ({
  method: 'thread/tokenUsage/updated',
  params: {
    threadId: 'thread-1',
    turnId: 'turn-1',
    tokenUsage: {
      last,
      total: { ...last, inputTokens: last.inputTokens + 780, totalTokens: last.totalTokens + 990 },
      modelContextWindow: 200000
    }
  }
})

const turnCompleted = (status: string, durationMs: number | null = 2049): RawCodexNotification => ({
  method: 'turn/completed',
  params: { threadId: 'thread-1', turn: { id: 'turn-1', status, durationMs } }
})

const errorNotification = (
  willRetry: boolean,
  message = 'upstream overloaded'
): RawCodexNotification => ({
  method: 'error',
  params: { threadId: 'thread-1', turnId: 'turn-1', willRetry, error: { message } }
})

const outputDelta = (delta: string, itemId = 'item-3'): RawCodexNotification => ({
  method: 'item/commandExecution/outputDelta',
  params: { delta, itemId, threadId: 'thread-1', turnId: 'turn-1' }
})

const reasoningDelta: RawCodexNotification = {
  method: 'item/reasoning/textDelta',
  params: {
    delta: 'thinking...',
    itemId: 'item-r1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    contentIndex: 0
  }
}

const types = (evs: AgentEvent[]): string[] => evs.map((e) => e.type)

function normalizeAll(
  norm: ReturnType<typeof createCodexNormalizer>,
  raws: RawCodexNotification[]
): AgentEvent[] {
  const out: AgentEvent[] = []
  for (const raw of raws) {
    const boundary = norm.turnBoundary(raw)
    if (boundary) norm.turnResult() // mirror the harness call order (invariant 7)
    out.push(...norm.normalize(raw, ctx))
  }
  return out
}

describe('codex normalize', () => {
  it('agent-message delta → content.delta with the delta text', () => {
    const norm = createCodexNormalizer({ resumed: false, model: 'gpt-5-codex' })
    const evs = norm.normalize(agentMessageDelta('Hello'), ctx)
    expect(types(evs)).toEqual(['content.delta'])
    const ev = evs[0]
    if (ev.type === 'content.delta') expect(ev.payload.text).toBe('Hello')
  })

  it('item/completed(agentMessage) → finalized assistant.message with the full text', () => {
    const norm = createCodexNormalizer({ resumed: false, model: 'gpt-5-codex' })
    norm.normalize(agentMessageDelta('Hel'), ctx)
    norm.normalize(agentMessageDelta('lo'), ctx)
    const evs = norm.normalize(agentMessageCompleted('Hello world'), ctx)
    expect(types(evs)).toEqual(['assistant.message'])
    const ev = evs[0]
    if (ev.type === 'assistant.message') expect(ev.payload.text).toBe('Hello world')
  })

  it('commandExecution start/end → tool.call.started/completed, isError from exitCode', () => {
    const norm = createCodexNormalizer({ resumed: false, model: 'gpt-5-codex' })
    const started = norm.normalize(commandStarted('item-3'), ctx)
    expect(types(started)).toEqual(['tool.call.started'])
    const s = started[0]
    if (s.type === 'tool.call.started') {
      expect(s.payload.toolCallId).toBe('item-3')
      expect(s.payload.name).toBe('shell')
    }

    const ok = norm.normalize(
      commandCompleted({
        itemId: 'item-3',
        exitCode: 0,
        status: 'completed',
        aggregatedOutput: 'all good'
      }),
      ctx
    )
    expect(types(ok)).toEqual(['tool.call.completed'])
    const okEv = ok[0]
    if (okEv.type === 'tool.call.completed') {
      expect(okEv.payload.toolCallId).toBe('item-3')
      expect(okEv.payload.name).toBe('shell')
      expect(okEv.payload.outputPreview).toBe('all good')
      expect(okEv.payload.isError).toBe(false)
    }

    const failed = norm.normalize(
      commandCompleted({
        itemId: 'item-5',
        exitCode: 1,
        status: 'completed',
        aggregatedOutput: 'boom'
      }),
      ctx
    )
    const failEv = failed[0]
    if (failEv.type === 'tool.call.completed') expect(failEv.payload.isError).toBe(true)

    const declined = norm.normalize(
      commandCompleted({
        itemId: 'item-6',
        exitCode: null,
        status: 'declined',
        aggregatedOutput: null
      }),
      ctx
    )
    const declEv = declined[0]
    if (declEv.type === 'tool.call.completed') expect(declEv.payload.isError).toBe(true)

    const timedOutFailed = norm.normalize(
      commandCompleted({
        itemId: 'item-7',
        exitCode: null,
        status: 'failed',
        aggregatedOutput: null
      }),
      ctx
    )
    const failedEv = timedOutFailed[0]
    if (failedEv.type === 'tool.call.completed') expect(failedEv.payload.isError).toBe(true)
  })

  it('commandExecution/outputDelta accumulates and is used only as a fallback when aggregatedOutput is absent', () => {
    const norm = createCodexNormalizer({ resumed: false, model: 'gpt-5-codex' })
    norm.normalize(commandStarted('item-3'), ctx)
    expect(norm.normalize(outputDelta('partial-line\n'), ctx)).toEqual([])
    const completed = norm.normalize(
      commandCompleted({
        itemId: 'item-3',
        exitCode: 0,
        status: 'completed',
        aggregatedOutput: null
      }),
      ctx
    )
    const ev = completed[0]
    if (ev.type === 'tool.call.completed') expect(ev.payload.outputPreview).toBe('partial-line\n')
  })

  it('fileChange start/end → tool.call.started/completed (write), isError from status', () => {
    const norm = createCodexNormalizer({ resumed: false, model: 'gpt-5-codex' })
    const started = norm.normalize(fileChangeStarted('item-4'), ctx)
    const s = started[0]
    if (s.type === 'tool.call.started') {
      expect(s.payload.toolCallId).toBe('item-4')
      expect(s.payload.name).toBe('write')
    }
    norm.normalize(patchUpdated('item-4'), ctx) // streaming update — no event
    const ok = norm.normalize(fileChangeCompleted({ itemId: 'item-4', status: 'completed' }), ctx)
    const okEv = ok[0]
    if (okEv.type === 'tool.call.completed') {
      expect(okEv.payload.name).toBe('write')
      expect(okEv.payload.isError).toBe(false)
      expect(okEv.payload.outputPreview).toContain('src/foo.ts')
    }
    const declined = norm.normalize(
      fileChangeCompleted({ itemId: 'item-8', status: 'declined', changes: [] }),
      ctx
    )
    const declEv = declined[0]
    if (declEv.type === 'tool.call.completed') expect(declEv.payload.isError).toBe(true)
  })

  it('reasoning deltas are dropped (no reasoning event in AgentEvent v1)', () => {
    const norm = createCodexNormalizer({ resumed: false, model: 'gpt-5-codex' })
    expect(norm.normalize(reasoningDelta, ctx)).toEqual([])
  })

  it('unknown notification methods are log-and-ignored', () => {
    const norm = createCodexNormalizer({ resumed: false, model: 'gpt-5-codex' })
    expect(norm.normalize({ method: 'thread/rollback', params: {} }, ctx)).toEqual([])
    expect(
      norm.normalize({ method: 'account/chatgptAuthTokens/refresh', params: {} }, ctx)
    ).toEqual([])
  })

  it('multi-pass turn: only ONE turnBoundary across item sub-steps, single turn.completed', () => {
    const norm = createCodexNormalizer({ resumed: false, model: 'gpt-5-codex' })
    const sequence = [
      turnStarted(),
      commandStarted('item-3'),
      commandCompleted({
        itemId: 'item-3',
        exitCode: 0,
        status: 'completed',
        aggregatedOutput: 'ok'
      }),
      agentMessageDelta('done', 'item-1'),
      agentMessageCompleted('done', 'item-1'),
      turnCompleted('completed')
    ]

    const boundaries = sequence.map((raw) => norm.turnBoundary(raw))
    expect(boundaries.filter((b) => b !== null)).toEqual(['success'])
    // Every intermediate item start/complete + delta is NOT a boundary.
    expect(boundaries.slice(0, -1)).toEqual([null, null, null, null, null])

    const evs = normalizeAll(
      createCodexNormalizer({ resumed: false, model: 'gpt-5-codex' }),
      sequence
    )
    expect(types(evs)).toEqual([
      'tool.call.started',
      'tool.call.completed',
      'content.delta',
      'assistant.message',
      'turn.completed'
    ])
    expect(types(evs).filter((t) => t === 'turn.completed')).toHaveLength(1)
  })

  it('thread/tokenUsage/updated is cached (no event) and surfaces at turn.completed using `last`', () => {
    const norm = createCodexNormalizer({ resumed: false, model: 'gpt-5-codex' })
    norm.normalize(turnStarted(), ctx)
    const cacheEvs = norm.normalize(
      tokenUsageUpdated({
        inputTokens: 120,
        cachedInputTokens: 40,
        outputTokens: 30,
        reasoningOutputTokens: 10,
        totalTokens: 160
      }),
      ctx
    )
    expect(cacheEvs).toEqual([]) // no event emitted for the usage notification itself

    const raw = turnCompleted('completed', 2049)
    const boundary = norm.turnBoundary(raw)
    expect(boundary).toBe('success')
    const result = norm.turnResult()
    expect(result.inputTokens).toBe(120)
    expect(result.outputTokens).toBe(30)
    expect(result.costUsd).toBeNull() // no cost anywhere on the wire (contract §7)
    expect(result.durationMs).toBe(2049)
    expect(result.isError).toBe(false)
    expect(result.model).toBe('gpt-5-codex')
    expect(result.authFailure).toBe(false)

    const evs = norm.normalize(raw, ctx)
    expect(types(evs)).toEqual(['turn.completed'])
    const done = evs[0]
    if (done.type === 'turn.completed') {
      expect(done.payload.status).toBe('success')
      expect(done.payload.inputTokens).toBe(120)
      expect(done.payload.outputTokens).toBe(30)
      expect(done.payload.costUsd).toBeNull()
      expect(done.payload.durationMs).toBe(2049)
    }
  })

  it('turn/completed status "failed" → turnBoundary "error", turn.completed payload status "error"', () => {
    const norm = createCodexNormalizer({ resumed: false, model: 'gpt-5-codex' })
    const raw = turnCompleted('failed', 500)
    expect(norm.turnBoundary(raw)).toBe('error')
    expect(norm.turnResult().isError).toBe(true)
    const evs = norm.normalize(raw, ctx)
    const done = evs[0]
    if (done.type === 'turn.completed') expect(done.payload.status).toBe('error')
  })

  it('turn/completed status "interrupted" → turnBoundary "interrupted", not an error', () => {
    const norm = createCodexNormalizer({ resumed: false, model: 'gpt-5-codex' })
    const raw = turnCompleted('interrupted', 100)
    expect(norm.turnBoundary(raw)).toBe('interrupted')
    expect(norm.turnResult().isError).toBe(false)
    const evs = norm.normalize(raw, ctx)
    const done = evs[0]
    if (done.type === 'turn.completed') expect(done.payload.status).toBe('interrupted')
  })

  it('error notification willRetry:false → fatal session.error event', () => {
    const norm = createCodexNormalizer({ resumed: false, model: 'gpt-5-codex' })
    const evs = norm.normalize(errorNotification(false, 'connection reset'), ctx)
    expect(types(evs)).toEqual(['session.error'])
    const ev = evs[0]
    if (ev.type === 'session.error') expect(ev.payload.message).toBe('connection reset')
  })

  it('error notification willRetry:true → non-fatal, no event (dropped)', () => {
    const norm = createCodexNormalizer({ resumed: false, model: 'gpt-5-codex' })
    expect(norm.normalize(errorNotification(true, 'transient'), ctx)).toEqual([])
  })

  it('authErrorResult always returns null (no typed auth-failure channel on the Codex wire)', () => {
    const norm = createCodexNormalizer({ resumed: false, model: 'gpt-5-codex' })
    expect(norm.authErrorResult(errorNotification(false, 'unauthorized'))).toBeNull()
    expect(norm.authErrorResult(turnCompleted('failed'))).toBeNull()
  })

  it('turn/started resets per-turn usage accounting', () => {
    const norm = createCodexNormalizer({ resumed: false, model: 'gpt-5-codex' })
    norm.normalize(
      tokenUsageUpdated({
        inputTokens: 999,
        cachedInputTokens: 0,
        outputTokens: 999,
        reasoningOutputTokens: 0,
        totalTokens: 1998
      }),
      ctx
    )
    norm.normalize(turnStarted(), ctx) // new turn — usage should reset
    const raw = turnCompleted('completed', 10)
    norm.turnBoundary(raw)
    const result = norm.turnResult()
    expect(result.inputTokens).toBeNull()
    expect(result.outputTokens).toBeNull()
  })
})
