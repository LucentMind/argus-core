import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent } from '../../../shared/agent-events'
import type { ApprovalDecision } from '../../../shared/types'
import type { PermissionMode } from '../../../shared/settings'
import { AsyncQueue } from './asyncQueue'
import { normalizeSdkMessage, makeEvent, type NormalizeCtx } from './normalize'
import { classifyToolCall, type RiskContext } from './risk'
import type { RiskLevel } from '../../../shared/connectors'
import { PendingApprovals, SessionGrants } from './approvals'
import { createArgusMcpServer } from './nativeTools'
import { caseDir } from '../paths'
import { isEditableTool } from '../../../shared/editableTools'
import { composePersona } from './persona'
import { filteredIndex } from '../memory'
import { defaultAgentAccess, type AgentAccess } from '../../../shared/agentAccess'
import { touchSession, setTitleIfEmpty } from './sessionStore'

export type QueryHandle = AsyncIterable<unknown> & { interrupt(): Promise<void> }
export type CreateQueryFn = (args: {
  prompt: AsyncIterable<unknown>
  options: Record<string, unknown>
}) => QueryHandle

export interface SessionMirrorLike {
  append(e: AgentEvent): void
  indexText(role: string, content: string, turnId: number | null): void
}

export interface SessionAgentOptions {
  model?: string
  cliPath?: string
  permissionMode?: PermissionMode
  personaAppend?: string
}

export interface SessionDeps {
  db: DatabaseSync
  argusHome: string
  caseId: number
  caseSlug: string
  sessionId: number
  workspaceRoots: string[]
  skillsRoots: string[]
  /** Pack-contributed persona fragments (from PackRegistry), injected after the base persona. */
  personaFragments?: string[]
  emit: (e: AgentEvent) => void
  createQuery: CreateQueryFn
  resumeSdkSessionId: string | null
  mirror?: SessionMirrorLike
  agentOptions?: SessionAgentOptions
  /** Live tool-risk overrides, re-read on every permission decision. */
  toolRisk?: () => Record<string, RiskLevel>
  /** Live agent-access overrides (skills/memory), re-read at construction. */
  agentAccess?: () => AgentAccess
  /** Connector servers composed for this session (new sessions only). */
  extraMcpServers?: Record<string, unknown>
  /** Connectors that could not be composed; logged to the event stream at start. */
  mcpSkipped?: Array<{ instanceId: string; reason: string }>
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
  private currentModel: string | null = null

  constructor(deps: SessionDeps) {
    this.deps = deps
    this.sessionId = deps.sessionId
    touchSession(deps.db, deps.sessionId)
    const dir = caseDir(deps.argusHome, deps.caseSlug)
    const access = deps.agentAccess?.() ?? defaultAgentAccess()
    const memIndex = filteredIndex(deps.argusHome, access)
    const memoryAppend = memIndex.trim()
      ? `\n\n## Agent memory\nLessons from previous cases. Load a topic with the read_memory tool when its index line is relevant to this case — memory files are not readable via filesystem tools.\n\n${memIndex.trim()}`
      : ''
    this.riskCtx = {
      caseDir: dir,
      workspaceRoots: deps.workspaceRoots,
      readonlyRoots: [...deps.skillsRoots]
    }
    const ao = deps.agentOptions ?? {}
    this.query = deps.createQuery({
      prompt: this.promptQueue,
      options: {
        cwd: dir,
        additionalDirectories: [...deps.workspaceRoots, ...deps.skillsRoots],
        includePartialMessages: true,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: composePersona(deps.personaFragments ?? [], ao.personaAppend) + memoryAppend
        },
        ...(ao.model ? { model: ao.model } : {}),
        ...(ao.cliPath ? { pathToClaudeCodeExecutable: ao.cliPath } : {}),
        ...(ao.permissionMode && ao.permissionMode !== 'default'
          ? { permissionMode: ao.permissionMode }
          : {}),
        mcpServers: {
          ...(deps.extraMcpServers ?? {}),
          argus: createArgusMcpServer({
            db: deps.db,
            argusHome: deps.argusHome,
            caseId: deps.caseId,
            caseSlug: deps.caseSlug,
            sessionId: this.sessionId,
            emitFinding: (markdown) =>
              this.emit(makeEvent(this.ctx(), 'case.finding.added', { markdown })),
            agentAccess: () => deps.agentAccess?.() ?? defaultAgentAccess()
          })
        },
        canUseTool: this.canUseTool.bind(this),
        ...(deps.resumeSdkSessionId && UUID_RE.test(deps.resumeSdkSessionId)
          ? { resume: deps.resumeSdkSessionId }
          : {})
      }
    })
    // Deferred past the synchronous construction+mirror-attach block: AgentService
    // attaches the mirror right after `new CaseSession(...)` returns, and these
    // events must land in the session's .jsonl mirror, not just the live broadcast.
    queueMicrotask(() => {
      if (this.state === 'dead') return
      for (const s of deps.mcpSkipped ?? [])
        this.emit(
          makeEvent(this.ctx(), 'session.mcp.skipped', {
            instanceId: s.instanceId,
            reason: s.reason
          })
        )
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
    this.deps.mirror?.append(this.forMirror(e))
    this.deps.emit(e)
  }

  // The mirror is a durable per-case .jsonl log; the live broadcast keeps the full
  // tool input so the approval UI can render/edit it, but persisting raw tool args
  // (comment bodies, file paths, …) to disk is unnecessary — strip it for the
  // mirrored copy only.
  private forMirror(e: AgentEvent): AgentEvent {
    if (e.type !== 'request.opened' || e.payload.input === undefined) return e
    const { requestId, tool, risk, grantKey, argsPreview } = e.payload
    return { ...e, payload: { requestId, tool, risk, grantKey, argsPreview } }
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
    setTitleIfEmpty(this.deps.db, this.sessionId, text)
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
    return this.approvals.resolve(d.requestId, d.kind, d.comment, d.updatedInput)
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
  ): Promise<
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  > {
    const started = Date.now()
    const verdict = classifyToolCall(toolName, input, {
      ...this.riskCtx,
      toolRisk: this.deps.toolRisk?.()
    })
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
        argsPreview,
        input
      })
    )
    const outcome = await this.approvals.open(
      { requestId, tool: toolName, risk: verdict.risk, grantKey: verdict.grantKey, argsPreview },
      opts.signal
    )
    this.emit(makeEvent(this.ctx(), 'request.resolved', { requestId, decision: outcome.decision }))

    if (outcome.decision === 'allow' || outcome.decision === 'allow-session') {
      if (outcome.decision === 'allow-session' && verdict.grantKey)
        this.grants.add(verdict.grantKey)
      log(outcome.decision === 'allow-session' ? 'grant' : 'user')
      // Defense in depth: edited inputs are only a connector-tool (MCP) feature —
      // never substitute args on Bash/native asks, whatever the IPC caller sent.
      // Argus's own native tools are exposed as an `mcp__argus__*` server too, so
      // they're excluded from the editable set alongside Bash — except the narrow
      // allowlist in shared/editableTools (currently just write_memory), where the
      // args are pure reviewed content and editing is the review mechanism.
      return {
        behavior: 'allow',
        updatedInput: (isEditableTool(toolName) ? outcome.updatedInput : undefined) ?? input
      }
    }
    log(outcome.decision === 'cancelled' ? 'cancelled' : 'denied')
    return {
      behavior: 'deny',
      message:
        outcome.comment ?? (outcome.decision === 'cancelled' ? 'Cancelled' : 'Denied by user')
    }
  }

  // --- stream consumption ----------------------------------------------------
  private updateCursor(msg: {
    type?: string
    subtype?: string
    session_id?: string
    model?: string
  }): void {
    if (msg.type === 'system' && msg.subtype === 'init' && msg.model) {
      this.currentModel = String(msg.model)
    }
    const durable = (msg.type === 'system' && msg.subtype === 'init') || msg.type === 'result'
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
          `UPDATE turns SET status = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, duration_ms = ?, model = ?
           WHERE id = ?`
        )
        .run(
          msg.is_error ? 'error' : 'success',
          msg.usage?.input_tokens ?? null,
          msg.usage?.output_tokens ?? null,
          msg.total_cost_usd ?? null,
          msg.duration_ms ?? null,
          this.currentModel,
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
        this.emit(
          makeEvent(this.ctx(), 'session.exited', { reason: interrupted ? 'stopped' : 'crashed' })
        )
      }
    } finally {
      this.activeTurn = false
    }
  }
}
