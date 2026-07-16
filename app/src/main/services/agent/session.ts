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
import { createArgusMcpServer, appendFinding, type NativeToolDeps } from './nativeTools'
import {
  buildPanelCommandServers,
  panelCommandRiskMap,
  type PanelCommandDecl
} from './panelCommands'
import type { Detection } from '../packs/detection'
import { caseDir } from '../paths'
import { ingestContent } from '../ingest'
import { isEditableTool } from '../../../shared/editableTools'
import { composePersona } from './persona'
import { filteredIndex } from '../memory'
import { defaultAgentAccess, type AgentAccess } from '../../../shared/agentAccess'
import { touchSession, setTitleIfEmpty } from './sessionStore'
import { maybeAdvanceToAnalyzing } from '../caseService'

export type QueryHandle = AsyncIterable<unknown> & { interrupt(): Promise<void> }
export type CreateQueryFn = (args: {
  prompt: AsyncIterable<unknown>
  options: Record<string, unknown>
}) => QueryHandle

export interface SessionMirrorLike {
  append(e: AgentEvent): void
  indexText(role: string, content: string, turnId: number | null): void
  close?(): void
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
  detection: Detection
  caseId: number
  caseSlug: string
  sessionId: number
  workspaceRoots: string[]
  skillsRoots: string[]
  /** Pack-contributed persona fragments (from PackRegistry), injected after the base persona. */
  personaFragments?: string[]
  /** Pack-declared CLI binary names (from PackRegistry), auto-allowlisted as LOW risk. */
  packCliNames?: string[]
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
  /** Fingerprint of `extraMcpServers` at construction; AgentService compares it per send
   *  to decide whether this session's frozen mcpServers map is still correct. */
  mcpFingerprint?: string
  /** Open/focus a panel in this session's case (3b-2); session-bound by AgentService. */
  openPanel?: NativeToolDeps['openPanel']
  /** Capture a panel to evidence in this session's case; session-bound by AgentService. */
  capturePanel?: NativeToolDeps['capturePanel']
  /** Pack-declared panel commands (3b-2), registered as mcp__<pack>__<window>_<cmd> tools. */
  panelCommandDecls?: PanelCommandDecl[]
  /** Dispatch a panel command to the open panel (3b-2); session-bound by AgentService. */
  dispatchPanelCommand?: (
    packId: string,
    windowId: string,
    cmd: string,
    args: unknown[]
  ) => Promise<unknown>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Tool name for the panel-initiated finding approval card (MEDIUM, editable). Distinct from the
 *  agent's own mcp__argus__append_finding, which stays auto-approved. */
export const PANEL_FINDING_TOOL = 'mcp__argus__panel_emit_finding'

/** Tool name for the panel-initiated evidence-ingest approval card (MEDIUM, editable). */
export const PANEL_INGEST_TOOL = 'mcp__argus__panel_ingest_evidence'

export class CaseSession {
  readonly sessionId: number
  readonly mcpFingerprint: string
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
    this.mcpFingerprint = deps.mcpFingerprint ?? ''
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
      readonlyRoots: [...deps.skillsRoots],
      packCliNames: deps.packCliNames,
      panelCommandRisk: panelCommandRiskMap(deps.panelCommandDecls ?? [])
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
          ...(deps.dispatchPanelCommand
            ? buildPanelCommandServers(deps.panelCommandDecls ?? [], deps.dispatchPanelCommand)
            : {}),
          argus: createArgusMcpServer({
            db: deps.db,
            argusHome: deps.argusHome,
            detection: deps.detection,
            caseId: deps.caseId,
            caseSlug: deps.caseSlug,
            sessionId: this.sessionId,
            currentTurnId: () => this.currentTurnRow,
            emitFinding: (markdown) =>
              this.emit(makeEvent(this.ctx(), 'case.finding.added', { markdown })),
            agentAccess: () => deps.agentAccess?.() ?? defaultAgentAccess(),
            openPanel: deps.openPanel,
            capturePanel: deps.capturePanel
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

  send(text: string): number {
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
    maybeAdvanceToAnalyzing(this.deps.db, this.deps.argusHome, this.deps.caseId)
    setTitleIfEmpty(this.deps.db, this.sessionId, text)
    this.deps.mirror?.indexText('user', text, this.currentTurnRow)
    this.emit(makeEvent(this.ctx(), 'turn.started', { userText: text }))
    this.promptQueue.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: ''
    })
    return this.turnIndex
  }

  /** Panel-initiated finding: raise a MEDIUM editable approval card, then (on approve) write it
   *  through the same finding path as the agent. No-op card reuse of canUseTool — routed directly. */
  async emitPanelFinding(input: {
    title: string
    markdown: string
  }): Promise<{ ok: boolean; findingId?: number }> {
    if (this.state === 'dead') return { ok: false }
    const requestId = crypto.randomUUID()
    const argsPreview = JSON.stringify(input).slice(0, 400)
    this.emit(
      makeEvent(this.ctx(), 'request.opened', {
        requestId,
        tool: PANEL_FINDING_TOOL,
        risk: 'MEDIUM',
        grantKey: null,
        argsPreview,
        input
      })
    )
    const outcome = await this.approvals.open({
      requestId,
      tool: PANEL_FINDING_TOOL,
      risk: 'MEDIUM',
      grantKey: null,
      argsPreview
    })
    this.emit(makeEvent(this.ctx(), 'request.resolved', { requestId, decision: outcome.decision }))
    if (outcome.decision !== 'allow' && outcome.decision !== 'allow-session') return { ok: false }
    const edited = outcome.updatedInput as { title?: string; markdown?: string } | undefined
    const { findingId, block } = appendFinding(
      {
        db: this.deps.db,
        argusHome: this.deps.argusHome,
        caseId: this.deps.caseId,
        caseSlug: this.deps.caseSlug,
        sessionId: this.sessionId,
        turnId: this.currentTurnRow
      },
      {
        title: String(edited?.title ?? input.title),
        markdown: String(edited?.markdown ?? input.markdown)
      }
    )
    this.emit(makeEvent(this.ctx(), 'case.finding.added', { markdown: block }))
    return { ok: true, findingId }
  }

  /** Panel-initiated evidence ingest (3d-2): raise a MEDIUM editable approval card showing the
   *  target filename + source, then (on approve) download/read the bytes and ingest through the
   *  same pipeline the agent's own ingest_artifact tool uses. */
  async ingestPanelEvidence(input: {
    source: { url: string } | { bytes: Buffer }
    filename: string
  }): Promise<{ ok: true; evidenceId: string } | { ok: false; reason: string }> {
    if (this.state === 'dead') return { ok: false, reason: 'session-dead' }
    const requestId = crypto.randomUUID()
    const sourcePreview =
      'url' in input.source ? input.source.url : `${input.source.bytes.byteLength} bytes from panel`
    const preview = { filename: input.filename, source: sourcePreview }
    const argsPreview = JSON.stringify(preview).slice(0, 400)
    this.emit(
      makeEvent(this.ctx(), 'request.opened', {
        requestId,
        tool: PANEL_INGEST_TOOL,
        risk: 'MEDIUM',
        grantKey: null,
        argsPreview,
        input: preview
      })
    )
    const outcome = await this.approvals.open({
      requestId,
      tool: PANEL_INGEST_TOOL,
      risk: 'MEDIUM',
      grantKey: null,
      argsPreview
    })
    this.emit(makeEvent(this.ctx(), 'request.resolved', { requestId, decision: outcome.decision }))
    if (outcome.decision !== 'allow' && outcome.decision !== 'allow-session') {
      return { ok: false, reason: 'denied' }
    }
    const edited = outcome.updatedInput as { filename?: string } | undefined
    const filename = String(edited?.filename ?? input.filename)

    // Defense in depth: the approval card's filename is operator-editable, so re-validate the
    // EFFECTIVE name here (the bridge only checked the panel's original input). A traversal /
    // separator in the edited name would otherwise escape the case evidence dir on write.
    if (/[\\/]/.test(filename) || filename === '' || filename === '.' || filename === '..') {
      return { ok: false, reason: 'invalid-filename' }
    }

    let content: Buffer
    const extraMeta: Record<string, unknown> = {}
    if ('url' in input.source) {
      try {
        // redirect:'manual' — the origin allowlist is enforced only on the initial URL (bridge),
        // so following a redirect could reach an unallowlisted/internal target (SSRF). A 3xx
        // becomes a non-ok response here and is rejected below.
        const res = await fetch(input.source.url, { redirect: 'manual' })
        if (!res.ok) return { ok: false, reason: `fetch-failed:${res.status}` }
        content = Buffer.from(await res.arrayBuffer())
        extraMeta.sourceUrl = input.source.url
      } catch {
        return { ok: false, reason: 'fetch-failed' }
      }
    } else {
      content = input.source.bytes
    }

    const rec = ingestContent(
      this.deps.db,
      this.deps.argusHome,
      this.deps.detection,
      this.deps.caseSlug,
      filename,
      content,
      'panel',
      extraMeta
    )
    this.emit(
      makeEvent(this.ctx(), 'case.evidence.ingested', { evidenceId: rec.id, relPath: rec.relPath })
    )
    return { ok: true, evidenceId: String(rec.id) }
  }

  respond(d: ApprovalDecision): boolean {
    return this.approvals.resolve(d.requestId, d.kind, d.comment, d.updatedInput)
  }

  async interrupt(): Promise<void> {
    await this.query.interrupt().catch(() => undefined)
  }

  async stop(reason: 'stopped' | 'reaped' | 'reconfigured'): Promise<void> {
    if (this.state === 'dead') return
    this.state = 'dead'
    for (const id of this.approvals.drain()) {
      this.emit(makeEvent(this.ctx(), 'request.resolved', { requestId: id, decision: 'cancelled' }))
    }
    this.promptQueue.end()
    await this.interrupt()
    this.emit(makeEvent(this.ctx(), 'session.exited', { reason }))
    // The mirror is write-behind (buffers + a 250ms flush timer): without an explicit
    // close(), a caller that deletes the session's .jsonl right after stop() races the
    // pending flush, which recreates the file out from under the deletion.
    this.deps.mirror?.close?.()
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
    fallback_model?: string
  }): void {
    if (msg.type === 'system' && msg.subtype === 'init' && msg.model) {
      this.currentModel = String(msg.model)
    }
    // SDKModelRefusalFallbackMessage: a refusal made the model swap persistent for the
    // rest of the session, without re-emitting 'init'. Track it so later turns whose
    // result lacks modelUsage still fall back to the right model.
    if (msg.type === 'system' && msg.subtype === 'model_refusal_fallback' && msg.fallback_model) {
      this.currentModel = String(msg.fallback_model)
    }
    const durable = (msg.type === 'system' && msg.subtype === 'init') || msg.type === 'result'
    if (!durable || !msg.session_id || !UUID_RE.test(msg.session_id)) return
    this.deps.db
      .prepare(`UPDATE sessions SET sdk_session_id = ?, updated_at = ? WHERE id = ?`)
      .run(msg.session_id, new Date().toISOString(), this.sessionId)
  }

  // The result message's modelUsage is the authoritative per-turn record of which
  // model(s) actually ran (SDKResultSuccess/SDKResultError.modelUsage: Record<string,
  // ModelUsage>). Pick the model with the greatest input+output token usage; fall back
  // to the last-known model (init, or a model_refusal_fallback swap) if absent/empty.
  private resolveTurnModel(msg: {
    modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number }>
  }): string | null {
    const usage = msg.modelUsage
    if (usage && typeof usage === 'object') {
      let best: string | null = null
      let bestTotal = -1
      for (const [model, u] of Object.entries(usage)) {
        const total = (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0)
        if (total > bestTotal) {
          bestTotal = total
          best = model
        }
      }
      if (best != null) return best
    }
    return this.currentModel
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
          this.resolveTurnModel(msg),
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
