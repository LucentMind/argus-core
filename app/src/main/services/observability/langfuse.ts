import type { AgentEvent } from '../../../shared/agent-events'
import type { FindingRow } from '../../../shared/observability'

export interface LangfuseTraceLike {
  update(o: Record<string, unknown>): void
}
export interface LangfuseClientLike {
  trace(o: { id: string; name?: string; metadata?: Record<string, unknown> }): LangfuseTraceLike
  generation(o: Record<string, unknown>): void
  span(o: Record<string, unknown>): void
  score(o: { traceId: string; name: string; value: number; comment?: string }): void
  flushAsync(): Promise<void>
  shutdownAsync(): Promise<void>
}

interface SessionState {
  traceId: string
  model: string
  userText: string
  assistantText: string
  sessionId: number
}

export class LangfuseExporter {
  private sessions = new Map<number, SessionState>()
  private toolNames = new Map<string, string>()
  private error: string | null = null

  constructor(
    private client: LangfuseClientLike,
    private opts: { captureContent: boolean }
  ) {}

  private guard(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
    }
  }

  private traceIdFor(sessionId: number): string {
    return `argus-session-${sessionId}`
  }

  handle(e: AgentEvent): void {
    this.guard(() => {
      switch (e.type) {
        case 'session.started': {
          const traceId = this.traceIdFor(e.sessionId)
          this.client.trace({
            id: traceId,
            name: `${e.caseSlug} · session ${e.sessionId}`,
            metadata: { caseSlug: e.caseSlug, caseId: e.caseId }
          })
          this.sessions.set(e.sessionId, {
            traceId,
            model: e.payload.model,
            userText: '',
            assistantText: '',
            sessionId: e.sessionId
          })
          break
        }
        case 'turn.started': {
          const s = this.sessions.get(e.sessionId)
          if (s) {
            s.assistantText = ''
            s.userText = this.opts.captureContent ? e.payload.userText : ''
          }
          break
        }
        case 'assistant.message': {
          const s = this.sessions.get(e.sessionId)
          if (s && this.opts.captureContent) s.assistantText += e.payload.text
          break
        }
        case 'tool.call.started':
          this.toolNames.set(e.payload.toolCallId, e.payload.name)
          break
        case 'tool.call.completed': {
          const s = this.sessions.get(e.sessionId)
          if (!s) break
          this.client.span({
            traceId: s.traceId,
            name: `tool:${e.payload.name || this.toolNames.get(e.payload.toolCallId) || ''}`,
            level: e.payload.isError ? 'ERROR' : 'DEFAULT',
            ...(this.opts.captureContent ? { output: e.payload.outputPreview } : {})
          })
          break
        }
        case 'request.resolved': {
          const s = this.sessions.get(e.sessionId)
          if (!s) break
          const approved = e.payload.decision === 'allow' || e.payload.decision === 'allow-session'
          this.client.score({ traceId: s.traceId, name: 'hitl_approved', value: approved ? 1 : 0 })
          break
        }
        case 'turn.completed': {
          const s = this.sessions.get(e.sessionId)
          if (!s) break
          this.client.generation({
            traceId: s.traceId,
            name: 'turn',
            model: s.model,
            usage: {
              input: e.payload.inputTokens ?? undefined,
              output: e.payload.outputTokens ?? undefined
            },
            ...(e.payload.costUsd != null ? { totalCost: e.payload.costUsd } : {}),
            ...(this.opts.captureContent ? { input: s.userText, output: s.assistantText } : {})
          })
          if (e.payload.status === 'error')
            this.client.score({ traceId: s.traceId, name: 'turn_error', value: 1 })
          break
        }
      }
    })
  }

  scoreFinding(row: FindingRow | null): void {
    if (!row || row.sessionId == null || row.reviewState === 'pending') return
    this.guard(() => {
      this.client.score({
        traceId: this.traceIdFor(row.sessionId as number),
        name: 'finding_accepted',
        value: row.reviewState === 'accepted' ? 1 : 0
      })
    })
  }

  async flush(): Promise<void> {
    try {
      await this.client.flushAsync()
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
    }
  }

  lastError(): string | null {
    return this.error
  }
}
