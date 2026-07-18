import type { AgentEvent } from '../../../shared/agent-events'
import { seedFor, type ObservationIntent } from './intent'

export interface SessionState {
  seed: string
  model: string
  userText: string
  assistantText: string
  turnStartedAt: number | undefined
}

export interface ExporterState {
  sessions: Map<number, SessionState>
  tools: Map<string, { name: string; startedAt: number | undefined }>
}

export interface ReduceOpts {
  captureContent: boolean
}

export function initialState(): ExporterState {
  return { sessions: new Map(), tools: new Map() }
}

/** Epoch ms, or undefined when the event carries an unparseable timestamp. */
function tsOf(e: AgentEvent): number | undefined {
  const ms = Date.parse(e.ts)
  return Number.isFinite(ms) ? ms : undefined
}

/** Drops undefined-valued keys so intents compare cleanly with toEqual. */
function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
  return o
}

/** Returns a fresh session state initialized with seed and model. */
function freshSessionState(seed: string, model: string): SessionState {
  return { seed, model, userText: '', assistantText: '', turnStartedAt: undefined }
}

/**
 * Deterministic, I/O-free transition. State maps are mutated in place and the
 * same state object is returned; the tuple shape keeps call sites uniform.
 */
export function reduce(
  state: ExporterState,
  e: AgentEvent,
  opts: ReduceOpts
): [ExporterState, ObservationIntent[]] {
  const intents: ObservationIntent[] = []
  const seed = seedFor(e.sessionId)

  switch (e.type) {
    case 'session.started': {
      if (e.payload.resumed) {
        const existing = state.sessions.get(e.sessionId)
        if (existing) existing.model = e.payload.model
        else state.sessions.set(e.sessionId, freshSessionState(seed, e.payload.model))
        intents.push({ kind: 'event', seed, name: 'session resumed' })
        break
      }
      state.sessions.set(e.sessionId, freshSessionState(seed, e.payload.model))
      intents.push({
        kind: 'trace-root',
        seed,
        name: `${e.caseSlug} · session ${e.sessionId}`,
        metadata: { caseSlug: e.caseSlug, caseId: e.caseId }
      })
      break
    }

    case 'turn.started': {
      const s = state.sessions.get(e.sessionId)
      if (!s) break
      s.assistantText = ''
      s.userText = opts.captureContent ? e.payload.userText : ''
      s.turnStartedAt = tsOf(e)
      break
    }

    case 'assistant.message': {
      const s = state.sessions.get(e.sessionId)
      if (s && opts.captureContent) s.assistantText += e.payload.text
      break
    }

    case 'tool.call.started':
      state.tools.set(e.payload.toolCallId, { name: e.payload.name, startedAt: tsOf(e) })
      break

    case 'tool.call.completed': {
      const s = state.sessions.get(e.sessionId)
      const started = state.tools.get(e.payload.toolCallId)
      state.tools.delete(e.payload.toolCallId)
      if (!s) break
      intents.push(
        compact({
          kind: 'tool',
          seed,
          name: e.payload.name,
          startTime: started?.startedAt,
          endTime: tsOf(e),
          isError: e.payload.isError,
          output: opts.captureContent ? e.payload.outputPreview : undefined
        }) as ObservationIntent
      )
      break
    }

    case 'request.resolved': {
      if (!state.sessions.has(e.sessionId)) break
      const approved = e.payload.decision === 'allow' || e.payload.decision === 'allow-session'
      intents.push({ kind: 'score', seed, name: 'hitl_approved', value: approved ? 1 : 0 })
      break
    }

    case 'turn.completed': {
      const s = state.sessions.get(e.sessionId)
      if (!s) break
      const usage = compact({
        input: e.payload.inputTokens ?? undefined,
        output: e.payload.outputTokens ?? undefined
      })
      intents.push(
        compact({
          kind: 'generation',
          seed,
          name: 'turn',
          model: s.model,
          startTime: s.turnStartedAt,
          endTime: tsOf(e),
          usage: Object.keys(usage).length > 0 ? usage : undefined,
          costUsd: e.payload.costUsd ?? undefined,
          input: opts.captureContent ? s.userText : undefined,
          output: opts.captureContent ? s.assistantText : undefined
        }) as ObservationIntent
      )
      if (e.payload.status === 'error')
        intents.push({ kind: 'score', seed, name: 'turn_error', value: 1 })
      break
    }

    case 'session.error': {
      if (!state.sessions.has(e.sessionId)) break
      intents.push({
        kind: 'event',
        seed,
        name: 'session error',
        level: 'ERROR',
        metadata: { message: e.payload.message }
      })
      break
    }

    case 'session.exited':
      state.sessions.delete(e.sessionId)
      break
  }

  return [state, intents]
}
