import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent } from '../../../shared/agent-events'
import type { ApprovalDecision } from '../../../shared/types'
import type { PermissionMode } from '../../../shared/settings'
import { makeEvent, type NormalizeCtx } from './events'
import { classifyToolCall, type RiskContext } from './risk'
import type { AgentDriver, DriverSession, DriverSessionContext, TurnResult } from './driver'
import { isAuthFailure } from './drivers/claude'
import type { RiskLevel } from '../../../shared/connectors'
import { PendingApprovals, PendingDialogs, SessionGrants } from './approvals'
import { appendFinding, type NativeToolDeps } from './nativeTools'
import { panelCommandRiskMap, type PanelCommandDecl } from './panelCommands'
import type { Detection } from '../packs/detection'
import { caseDir } from '../paths'
import { ingestContent } from '../ingest'
import { isEditableTool } from '../../../shared/editableTools'
import { composePersona } from './persona'
import { filteredIndex } from '../memory'
import { defaultAgentAccess, type AgentAccess } from '../../../shared/agentAccess'
import { touchSession, setTitleIfEmpty } from './sessionStore'
import { maybeAdvanceToAnalyzing } from '../caseService'
import { extractToolDetail, type ToolDetailCtx } from './toolDetail'
import { sharedReferencesDir } from '../skillsDir'

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
  /** Resolved+enabled skill names (registry.ts); becomes the driver's skill allowlist. */
  enabledSkills?: string[]
  /** Pack-contributed persona fragments (from PackRegistry), injected after the base persona. */
  personaFragments?: string[]
  /** Pack-declared CLI binary names (from PackRegistry), auto-allowlisted as LOW risk. */
  packCliNames?: string[]
  emit: (e: AgentEvent) => void
  driver: AgentDriver
  resumeCursor: string | null
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
  /** `<instanceId>::<model>` this session was constructed for; AgentService compares it per
   *  send exactly like `mcpFingerprint`, because the model is likewise frozen at query()
   *  construction — re-pinning a chat to another provider/model must rebuild it. */
  modelKey?: string
  /** Fired when a turn fails auth-shaped (spec §5); index.ts calls authCache.onAuthFailure(). */
  onAuthFailure?: () => void
  /** Fired when a turn completes normally — the only real proof the credentials work. */
  onAuthVerified?: () => void
  /** Open/focus a panel in this session's case (3b-2); session-bound by AgentService. */
  openPanel?: NativeToolDeps['openPanel']
  /** Capture a panel to evidence in this session's case; session-bound by AgentService. */
  capturePanel?: NativeToolDeps['capturePanel']
  /** Fired by setCaseStatus after a non-closed→closed transition; enqueues distillation. */
  onCaseClosed?: NativeToolDeps['onCaseClosed']
  /** Fired after workspace_checkout materializes/switches a case worktree. */
  onWorktreeChanged?: NativeToolDeps['onWorktreeChanged']
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

/** Tool name for the panel-initiated finding approval card (MEDIUM, editable). Distinct from the
 *  agent's own mcp__argus__append_finding, which stays auto-approved. */
export const PANEL_FINDING_TOOL = 'mcp__argus__panel_emit_finding'

/** Tool name for the panel-initiated evidence-ingest approval card (MEDIUM, editable). */
export const PANEL_INGEST_TOOL = 'mcp__argus__panel_ingest_evidence'

/** Map the AskUserQuestion tool input to the renderer's question shape (defensive coercion:
 *  the tool input is typed Record<string, unknown>). Field names verified live 2026-07-22. */
function normalizeQuestions(input: Record<string, unknown>): Array<{
  question: string
  header: string
  multiSelect: boolean
  options: Array<{ label: string; description: string }>
}> {
  const raw = Array.isArray(input.questions) ? input.questions : []
  return raw.map((q) => {
    const qq = (q ?? {}) as Record<string, unknown>
    const opts = Array.isArray(qq.options) ? qq.options : []
    return {
      question: String(qq.question ?? ''),
      header: String(qq.header ?? ''),
      multiSelect: Boolean(qq.multiSelect),
      options: opts.map((o) => {
        const oo = (o ?? {}) as Record<string, unknown>
        return { label: String(oo.label ?? ''), description: String(oo.description ?? '') }
      })
    }
  })
}

export class CaseSession {
  readonly sessionId: number
  readonly mcpFingerprint: string
  readonly modelKey: string
  state: 'running' | 'dead' = 'running'
  activeTurn = false
  lastActivity = Date.now()

  private deps: SessionDeps
  private driverSession: DriverSession
  private approvals = new PendingApprovals()
  private dialogs = new PendingDialogs()
  private grants = new SessionGrants()
  private riskCtx: RiskContext
  private detailCtx: ToolDetailCtx
  private turnIndex = 0
  private currentTurnRow: number | null = null

  constructor(deps: SessionDeps) {
    this.deps = deps
    this.sessionId = deps.sessionId
    this.mcpFingerprint = deps.mcpFingerprint ?? ''
    this.modelKey = deps.modelKey ?? ''
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
      panelCommandRisk: panelCommandRiskMap(deps.panelCommandDecls ?? []),
      taxonomy: deps.driver.toolTaxonomy
    }
    this.detailCtx = {
      taxonomy: deps.driver.toolTaxonomy,
      referencesDir: sharedReferencesDir(deps.argusHome),
      caseDir: dir
    }
    const ao = deps.agentOptions ?? {}
    // The options bag, stream loop, cursor/result extraction, and the SDK prompt envelope
    // now live in the driver (agent/driver.ts + drivers/*). CaseSession supplies the
    // driver-agnostic context — persona/memory append, native tool deps, the approval
    // pipeline, and the DB-writing callbacks — and consumes the normalized event stream.
    const driverCtx: DriverSessionContext = {
      caseDir: dir,
      additionalDirectories: [...deps.workspaceRoots, ...deps.skillsRoots],
      skills: deps.enabledSkills ?? [],
      model: ao.model,
      cliPath: ao.cliPath,
      permissionMode: ao.permissionMode ?? 'default',
      systemAppend: composePersona(deps.personaFragments ?? [], ao.personaAppend) + memoryAppend,
      extraMcpServers: deps.extraMcpServers ?? {},
      nativeToolDeps: {
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
        capturePanel: deps.capturePanel,
        onCaseClosed: deps.onCaseClosed,
        onWorktreeChanged: deps.onWorktreeChanged
      },
      panelCommandDecls: deps.panelCommandDecls ?? [],
      dispatchPanelCommand: deps.dispatchPanelCommand,
      resumeCursor: deps.resumeCursor,
      eventCtx: () => this.ctx(),
      onToolRequest: this.handleToolRequest.bind(this),
      classifyOnly: this.classifyOnly.bind(this),
      // Usage-stats capture for the two classes the Claude SDK auto-allows without ever
      // consulting canUseTool (proven live 2026-07-20): `Skill` activations and sandboxed
      // reference reads. Everything else still audits through the approval pipeline —
      // observing those here too would double-count them. Copilot never fires this seam
      // (its reads audit via classifyOnly), so the split stays disjoint per driver.
      onToolObserved: (toolName, input) => {
        const detail = extractToolDetail(toolName, input, this.detailCtx)
        if (toolName !== 'Skill' && !detail?.startsWith('ref:')) return
        this.logToolCall(toolName, input, 'LOW', 'observed', 0)
      },
      // Tag the cursor with the driver that produced it — sessionCursor gates resume on
      // this match so a future Copilot driver can never resume a Claude session's cursor.
      onCursor: (cursor) => {
        this.deps.db
          .prepare(
            `UPDATE sessions SET driver_cursor = ?, driver_kind = ?, updated_at = ? WHERE id = ?`
          )
          .run(cursor, this.deps.driver.kind, new Date().toISOString(), this.sessionId)
      },
      onTurnResult: (r) => this.handleTurnResult(r)
    }
    this.driverSession = deps.driver.createSession(driverCtx)
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
    this.driverSession.send(text)
    return this.turnIndex
  }

  /** Panel-initiated finding: raise a MEDIUM editable approval card, then (on approve) write it
   *  through the same finding path as the agent. Bypasses the tool-approval pipeline — routed directly. */
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
    // Harness-side swallow (matches the pre-driver `query.interrupt().catch(...)`): stop()
    // awaits this between draining approvals and emitting session.exited / closing the
    // mirror, so a rejecting driver interrupt must never abort the teardown sequence or
    // surface to IPC callers — regardless of what any driver does internally.
    await this.driverSession.interrupt().catch(() => undefined)
  }

  async stop(reason: 'stopped' | 'reaped' | 'reconfigured'): Promise<void> {
    if (this.state === 'dead') return
    this.state = 'dead'
    for (const id of this.approvals.drain()) {
      this.emit(makeEvent(this.ctx(), 'request.resolved', { requestId: id, decision: 'cancelled' }))
    }
    for (const id of this.dialogs.drain()) {
      this.emit(makeEvent(this.ctx(), 'dialog.resolved', { dialogId: id, behavior: 'cancelled' }))
    }
    this.driverSession.end()
    await this.interrupt()
    this.emit(makeEvent(this.ctx(), 'session.exited', { reason }))
    // The mirror is write-behind (buffers + a 250ms flush timer): without an explicit
    // close(), a caller that deletes the session's .jsonl right after stop() races the
    // pending flush, which recreates the file out from under the deletion.
    this.deps.mirror?.close?.()
  }

  /** Append one row to the tool_calls audit trail. Shared by the ask pipeline and the
   *  classify-only seam so both write identical audit records. */
  private logToolCall(
    toolName: string,
    input: Record<string, unknown>,
    risk: string,
    decision: string,
    durationMs: number
  ): void {
    this.deps.db
      .prepare(
        `INSERT INTO tool_calls (case_id, session_id, turn_id, tool, args_hash, detail, risk, decision, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.deps.caseId,
        this.sessionId,
        this.currentTurnRow,
        toolName,
        crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16),
        extractToolDetail(toolName, input, this.detailCtx),
        risk,
        decision,
        durationMs,
        new Date().toISOString()
      )
  }

  /** Classify a tool call WITHOUT opening an approval card (the driver's classifyOnly seam).
   *  A permission-mode short-circuit that suppresses the *ask* (Copilot acceptEdits) calls this
   *  so a *deny* verdict — an out-of-sandbox or read-only-root write — is still enforced. The
   *  outcome is logged to the audit trail as 'auto' (allow/ask, since the ask is suppressed) or
   *  'denied', mirroring the ask pipeline's records. */
  private classifyOnly(
    toolName: string,
    input: Record<string, unknown>
  ): { action: 'allow' | 'ask' | 'deny'; reason?: string } {
    const started = Date.now()
    const verdict = classifyToolCall(toolName, input, {
      ...this.riskCtx,
      toolRisk: this.deps.toolRisk?.()
    })
    this.logToolCall(
      toolName,
      input,
      verdict.risk,
      verdict.action === 'deny' ? 'denied' : 'auto',
      Date.now() - started
    )
    return {
      action: verdict.action,
      ...('reason' in verdict ? { reason: verdict.reason } : {})
    }
  }

  // --- approval pipeline (the driver's onToolRequest): classify → decide → ask → log ---
  private async handleToolRequest(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal }
  ): Promise<
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  > {
    // AskUserQuestion is answered THROUGH canUseTool (verified live 2026-07-22): open a
    // Question dialog and return allow + updatedInput.answers. Never reaches the classifier
    // /approval-card path below, so no JSON-dump card appears.
    if (toolName === 'AskUserQuestion') return this.handleUserQuestion(input, opts)

    const started = Date.now()
    const verdict = classifyToolCall(toolName, input, {
      ...this.riskCtx,
      toolRisk: this.deps.toolRisk?.()
    })
    const log = (decision: string): void =>
      this.logToolCall(toolName, input, verdict.risk, decision, Date.now() - started)

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
    // Preview the args via the driver's taxonomy: a shell tool renders its command line;
    // everything else renders a truncated JSON blob (replaces the old `=== 'Bash'` check).
    const tax = this.deps.driver.toolTaxonomy.entries[toolName]
    const argsPreview =
      tax?.kind === 'shell'
        ? String(input[tax.commandField] ?? '')
        : JSON.stringify(input).slice(0, 400)
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

  // --- AskUserQuestion dialog: normalize → emit → await → allow(updatedInput.answers) ---
  private async handleUserQuestion(
    input: Record<string, unknown>,
    opts: { signal: AbortSignal }
  ): Promise<
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  > {
    const started = Date.now()
    const dialogId = crypto.randomUUID()
    const questions = normalizeQuestions(input)
    const passthroughQuestions = Array.isArray(input.questions) ? input.questions : []
    this.emit(makeEvent(this.ctx(), 'dialog.opened', { dialogId, questions }))
    const outcome = await this.dialogs.open(dialogId, opts.signal)
    this.emit(makeEvent(this.ctx(), 'dialog.resolved', { dialogId, behavior: outcome.behavior }))

    if (outcome.behavior === 'completed') {
      this.logToolCall('AskUserQuestion', input, 'LOW', 'answered', Date.now() - started)
      const updatedInput: Record<string, unknown> = {
        questions: passthroughQuestions,
        answers: outcome.result.answers
      }
      if (outcome.result.response) updatedInput.response = outcome.result.response
      return { behavior: 'allow', updatedInput }
    }
    // Skip / cancel / drain: return a CLEAN allow carrying a freeform response, not a deny.
    // A deny surfaces as an is_error tool_result and can make the agent retry the question;
    // an allow with `response` yields "The user responded: …" and the agent moves on.
    this.logToolCall('AskUserQuestion', input, 'LOW', 'cancelled', Date.now() - started)
    return {
      behavior: 'allow',
      updatedInput: {
        questions: passthroughQuestions,
        answers: {},
        response: 'The user dismissed the question without selecting an answer.'
      }
    }
  }

  /** Resolve a pending Question dialog from the renderer (mirrors respond → approvals.resolve). */
  answerDialog(a: {
    dialogId: string
    behavior: 'completed' | 'cancelled'
    result?: { answers: Record<string, string>; response?: string }
  }): boolean {
    return this.dialogs.resolve(
      a.dialogId,
      a.behavior === 'completed'
        ? { behavior: 'completed', result: a.result ?? { answers: {} } }
        : { behavior: 'cancelled' }
    )
  }

  // --- turn result + stream consumption --------------------------------------

  // Per-turn DB accounting + auth verdict, driven by the driver-extracted TurnResult
  // (the token/cost/model resolution and the auth-shape discrimination now live in the
  // driver). The turn is the ONLY thing that actually authenticates against the API — the
  // maxTurns:0 probe never does — so its outcome is the source of truth: an auth-shaped
  // failure clears the cached credentials, a clean turn proves they work, and a plain
  // (non-auth) error leaves the auth state untouched.
  private handleTurnResult(r: TurnResult): void {
    if (this.currentTurnRow != null) {
      this.deps.db
        .prepare(
          `UPDATE turns SET status = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, duration_ms = ?, model = ?
           WHERE id = ?`
        )
        .run(
          r.isError ? 'error' : 'success',
          r.inputTokens,
          r.outputTokens,
          r.costUsd,
          r.durationMs,
          r.model,
          this.currentTurnRow
        )
    }
    this.deps.db
      .prepare(`UPDATE sessions SET turn_count = turn_count + 1, updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), this.sessionId)
    if (r.authFailure) {
      this.deps.onAuthFailure?.()
    } else if (!r.isError) {
      this.deps.onAuthVerified?.()
    }
    this.activeTurn = false
  }

  private async consume(): Promise<void> {
    try {
      for await (const ev of this.driverSession.events()) {
        // tool-name backfill + cursor/turn-result extraction happen inside the driver;
        // CaseSession keeps only the mirror-index hook and the live/mirror broadcast.
        if (ev.type === 'assistant.message') {
          this.deps.mirror?.indexText('assistant', ev.payload.text, this.currentTurnRow)
        }
        this.emit(ev)
      }
      if (this.state !== 'dead') {
        this.state = 'dead'
        this.emit(makeEvent(this.ctx(), 'session.exited', { reason: 'stopped' }))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const interrupted = /abort|interrupt/i.test(message)
      // Prefer the active driver's own auth-error classifier when it has one (Copilot
      // reports auth failure via a typed channel + a distinct message substring); fall
      // back to the Claude heuristic, which remains correct for the Claude driver.
      const authFailed = this.deps.driver.isAuthErrorMessage
        ? this.deps.driver.isAuthErrorMessage(message)
        : isAuthFailure(message)
      if (!interrupted && authFailed) this.deps.onAuthFailure?.()
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
