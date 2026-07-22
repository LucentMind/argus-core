export type Risk = 'LOW' | 'MEDIUM' | 'HIGH'

export interface AgentEventBase {
  eventId: string
  caseId: number
  caseSlug: string
  sessionId: number
  turnId: number | null
  ts: string // ISO 8601
}

export type AgentEvent = AgentEventBase &
  (
    | { type: 'session.started'; payload: { model: string; resumed: boolean } }
    | {
        type: 'session.exited'
        payload: { reason: 'stopped' | 'reaped' | 'crashed' | 'reconfigured' }
      }
    | { type: 'session.error'; payload: { message: string; raw?: unknown } }
    | { type: 'turn.started'; payload: { userText: string } }
    | {
        type: 'turn.completed'
        payload: {
          status: 'success' | 'error' | 'interrupted'
          inputTokens: number | null
          outputTokens: number | null
          costUsd: number | null
          durationMs: number | null
        }
      }
    | { type: 'content.delta'; payload: { text: string } }
    | { type: 'assistant.message'; payload: { text: string } } // finalized text of the block(s)
    | { type: 'tool.call.started'; payload: { toolCallId: string; name: string } }
    | {
        type: 'tool.call.completed'
        payload: { toolCallId: string; name: string; outputPreview: string; isError: boolean }
      }
    | {
        type: 'request.opened'
        payload: {
          requestId: string
          tool: string
          risk: Risk
          grantKey: string | null
          argsPreview: string // human-readable rendering of the args
          input?: Record<string, unknown> // full args (asks only; absent in pre-Part-3 mirrors)
        }
      }
    | {
        type: 'request.resolved'
        payload: { requestId: string; decision: 'allow' | 'allow-session' | 'deny' | 'cancelled' }
      }
    | { type: 'case.finding.added'; payload: { markdown: string } }
    | { type: 'case.evidence.ingested'; payload: { evidenceId: number; relPath: string } }
    | { type: 'session.mcp.skipped'; payload: { instanceId: string; reason: string } }
    | {
        type: 'dialog.opened'
        payload: {
          dialogId: string
          questions: Array<{
            question: string
            header: string
            multiSelect: boolean
            options: Array<{ label: string; description: string }>
          }>
        }
      }
    | {
        type: 'dialog.resolved'
        payload: { dialogId: string; behavior: 'completed' | 'cancelled' }
      }
  )
