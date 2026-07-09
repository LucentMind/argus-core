import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent } from '../../../shared/agent-events'
import type { ApprovalDecision } from '../../../shared/types'
import { AsyncQueue } from './asyncQueue'
import { normalizeSdkMessage, makeEvent, type NormalizeCtx } from './normalize'
import { classifyToolCall, type RiskContext } from './risk'
import { PendingApprovals, SessionGrants } from './approvals'
import { createArgusMcpServer } from './nativeTools'
import { caseDir } from '../paths'
import { ARGUS_PERSONA } from './persona'

export type QueryHandle = AsyncIterable<unknown> & { interrupt(): Promise<void> }
export type CreateQueryFn = (args: {
  prompt: AsyncIterable<unknown>
  options: Record<string, unknown>
}) => QueryHandle

export interface SessionMirrorLike {
  append(e: AgentEvent): void
  indexText(role: string, content: string, turnId: number | null): void
}

export interface SessionDeps {
  db: DatabaseSync
  argusHome: string
  caseId: number
  caseSlug: string
  workspaceRoots: string[]
  skillsRoots: string[]
  emit: (e: AgentEvent) => void
  createQuery: CreateQueryFn
  resumeSdkSessionId: string | null
  mirror?: SessionMirrorLike
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class CaseSession {
  readonly sessionId: number
  state: 'running' | 'dead' = 'running'
  activeTurn = false
  lastActivity = Date.now()

  private deps: SessionDeps
  private promptQueue = new AsyncQueue<unknown>()
  private query: QueryHandle
  private approvals = new PendingApprovals()
  private grants = new SessionGrants()
  private riskCtx: RiskContext
  private turnIndex = 0
  private currentTurnRow: number | null = null
  private toolNames = new Map<string, string>() // toolCallId → name

  constructor(deps: SessionDeps) {
    this.deps = deps
    const now = new Date().toISOString()
    deps.db
      .prepare(
        `INSERT INTO sessions (case_id, sdk_session_id, turn_count, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?)
         ON CONFLICT(case_id) DO UPDATE SET updated_at = excluded.updated_at`
      )
      .run(deps.caseId, deps.resumeSdkSessionId, now, now)
    this.sessionId = Number(
      (deps.db.prepare(`SELECT id FROM sessions WHERE case_id = ?`).get(deps.caseId) as { id: number }).id
    )
    const dir = caseDir(deps.argusHome, deps.caseSlug)
    this.riskCtx = {
      caseDir: dir,
      workspaceRoots: deps.workspaceRoots,
      readonlyRoots: deps.skillsRoots
    }
    this.query = deps.createQuery({
      prompt: this.promptQueue,
      options: {
        cwd: dir,
        additionalDirectories: [...deps.workspaceRoots, ...deps.skillsRoots],
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: ARGUS_PERSONA },
        mcpServers: {
          argus: createArgusMcpServer({
            db: deps.db,
            argusHome: deps.argusHome,
            caseId: deps.caseId,
            caseSlug: deps.caseSlug,
            sessionId: this.sessionId,
            emitFinding: (markdown) =>
              this.emit(makeEvent(this.ctx(), 'case.finding.added', { markdown }))
          })
        },
        canUseTool: this.canUseTool.bind(this),
        ...(deps.resumeSdkSessionId && UUID_RE.test(deps.resumeSdkSessionId)
          ? { resume: deps.resumeSdkSessionId }
          : {})
      }
    })
    void this.consume()
  }

  private ctx(): NormalizeCtx {
    return {
      caseId: this.deps.caseId,
      caseSlug: this.deps.caseSlug,
      sessionId: this.sessionId,
      turnId: this.currentTurnRow
    }
  }

  private emit(e: AgentEvent): void {
    this.lastActivity = Date.now()
    this.deps.mirror?.append(e)
    this.deps.emit(e)
  }

  send(text: string): void {
    if (this.state === 'dead') throw new Error('session is dead')
    this.turnIndex++
    this.activeTurn = true
    const now = new Date().toISOString()
    const res = this.deps.db
      .prepare(
        `INSERT INTO turns (case_id, session_id, turn_index, status, created_at)
         VALUES (?, ?, ?, 'running', ?)`
      )
      .run(this.deps.caseId, this.sessionId, this.turnIndex, now)
    this.currentTurnRow = Number(res.lastInsertRowid)
    this.deps.mirror?.indexText('user', text, this.currentTurnRow)
    this.emit(makeEvent(this.ctx(), 'turn.started', { userText: text }))
    this.promptQueue.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: ''
    })
  }

  respond(d: ApprovalDecision): boolean {
    return this.approvals.resolve(d.requestId, d.kind, d.comment)
  }

  async interrupt(): Promise<void> {
    await this.query.interrupt().catch(() => undefined)
  }

  async stop(reason: 'stopped' | 'reaped'): Promise<void> {
    if (this.state === 'dead') return
    this.state = 'dead'
    for (const id of this.approvals.drain()) {
      this.emit(makeEvent(this.ctx(), 'request.resolved', { requestId: id, decision: 'cancelled' }))
    }
    this.promptQueue.end()
    await this.interrupt()
    this.emit(makeEvent(this.ctx(), 'session.exited', { reason }))
  }

  // --- canUseTool pipeline: classify → decide → ask → log -------------------
  private async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal }
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> {
    const started = Date.now()
    const verdict = classifyToolCall(toolName, input, this.riskCtx)
    const log = (decision: string): void => {
      this.deps.db
        .prepare(
          `INSERT INTO tool_calls (case_id, session_id, turn_id, tool, args_hash, risk, decision, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          this.deps.caseId,
          this.sessionId,
          this.currentTurnRow,
          toolName,
          crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16),
          verdict.risk,
          decision,
          Date.now() - started,
          new Date().toISOString()
        )
    }

    if (verdict.action === 'deny') {
      log('denied')
      return { behavior: 'deny', message: verdict.reason }
    }
    if (verdict.action === 'allow') {
      log('auto')
      return { behavior: 'allow', updatedInput: input }
    }
    if (verdict.grantKey && this.grants.has(verdict.grantKey)) {
      log('grant')
      return { behavior: 'allow', updatedInput: input }
    }

    const requestId = crypto.randomUUID()
    const argsPreview =
      toolName === 'Bash' ? String(input.command ?? '') : JSON.stringify(input).slice(0, 400)
    this.emit(
      makeEvent(this.ctx(), 'request.opened', {
        requestId,
        tool: toolName,
        risk: verdict.risk,
        grantKey: verdict.grantKey,
        argsPreview
      })
    )
    const outcome = await this.approvals.open(
      { requestId, tool: toolName, risk: verdict.risk, grantKey: verdict.grantKey, argsPreview },
      opts.signal
    )
    this.emit(makeEvent(this.ctx(), 'request.resolved', { requestId, decision: outcome.decision }))

    if (outcome.decision === 'allow' || outcome.decision === 'allow-session') {
      if (outcome.decision === 'allow-session' && verdict.grantKey) this.grants.add(verdict.grantKey)
      log(outcome.decision === 'allow-session' ? 'grant' : 'user')
      return { behavior: 'allow', updatedInput: input }
    }
    log(outcome.decision === 'cancelled' ? 'cancelled' : 'denied')
    return {
      behavior: 'deny',
      message: outcome.comment ?? (outcome.decision === 'cancelled' ? 'Cancelled' : 'Denied by user')
    }
  }

  // --- stream consumption ----------------------------------------------------
  private updateCursor(msg: { type?: string; subtype?: string; session_id?: string }): void {
    const durable =
      (msg.type === 'system' && msg.subtype === 'init') || msg.type === 'result'
    if (!durable || !msg.session_id || !UUID_RE.test(msg.session_id)) return
    this.deps.db
      .prepare(`UPDATE sessions SET sdk_session_id = ?, updated_at = ? WHERE id = ?`)
      .run(msg.session_id, new Date().toISOString(), this.sessionId)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleResult(msg: any): void {
    if (this.currentTurnRow != null) {
      this.deps.db
        .prepare(
          `UPDATE turns SET status = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, duration_ms = ?
           WHERE id = ?`
        )
        .run(
          msg.is_error ? 'error' : 'success',
          msg.usage?.input_tokens ?? null,
          msg.usage?.output_tokens ?? null,
          msg.total_cost_usd ?? null,
          msg.duration_ms ?? null,
          this.currentTurnRow
        )
    }
    this.deps.db
      .prepare(`UPDATE sessions SET turn_count = turn_count + 1, updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), this.sessionId)
    this.activeTurn = false
  }

  private async consume(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const msg of this.query as AsyncIterable<any>) {
        this.updateCursor(msg)
        if (msg.type === 'result') this.handleResult(msg)
        for (const ev of normalizeSdkMessage(msg, this.ctx())) {
          if (ev.type === 'tool.call.started') {
            this.toolNames.set(ev.payload.toolCallId, ev.payload.name)
          }
          if (ev.type === 'tool.call.completed' && !ev.payload.name) {
            ev.payload.name = this.toolNames.get(ev.payload.toolCallId) ?? ''
          }
          if (ev.type === 'assistant.message') {
            this.deps.mirror?.indexText('assistant', ev.payload.text, this.currentTurnRow)
          }
          this.emit(ev)
        }
      }
      if (this.state !== 'dead') {
        this.state = 'dead'
        this.emit(makeEvent(this.ctx(), 'session.exited', { reason: 'stopped' }))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const interrupted = /abort|interrupt/i.test(message)
      if (this.state !== 'dead') {
        this.state = 'dead'
        if (!interrupted) {
          this.emit(makeEvent(this.ctx(), 'session.error', { message }))
        }
        this.emit(makeEvent(this.ctx(), 'session.exited', { reason: interrupted ? 'stopped' : 'crashed' }))
      }
    } finally {
      this.activeTurn = false
    }
  }
}
