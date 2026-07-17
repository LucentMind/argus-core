import type { DatabaseSync } from 'node:sqlite'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent } from '../../../shared/agent-events'
import type { ApprovalDecision, CaseRecord } from '../../../shared/types'
import type { ComposedMcp, RiskLevel } from '../../../shared/connectors'
import { activeInstanceConfig, effectiveDefaultModel } from '../../../shared/drivers'
import { settingsSchema, type AgentSettings } from '../../../shared/settings'
import type { AgentAccess } from '../../../shared/agentAccess'
import { CaseSession, type CreateQueryFn, type SessionMirrorLike } from './session'
import type { PanelCommandDecl } from './panelCommands'
import { sessionCursor } from './sessionStore'
import { getCase } from '../caseService'
import { workspaceSandboxRoots } from '../workspaces'
import { materializeSessionSkills } from './skillsResolver'
import { CONTRIBUTE_BACK_NUDGE } from './persona'
import type { Detection } from '../packs/detection'

export interface AgentServiceDeps {
  db: DatabaseSync
  argusHome: string
  detection: Detection
  skillsRoots: string[]
  /** Live pack persona fragments (PackRegistry); read at each session construction. */
  personaFragments?: () => string[]
  /** Live pack-declared CLI binary names (PackRegistry); read at each session construction. */
  packCliNames?: () => string[]
  onEvent: (e: AgentEvent) => void
  /** Live agent-access overrides (skills/memory); consulted at each session construction. */
  agentAccess: () => AgentAccess
  createQuery?: CreateQueryFn
  maxSessions?: number
  mirrorFactory?: (caseSlug: string, sessionId: number) => SessionMirrorLike
  /** Live settings read at each session construction; falls back to maxSessions/defaults when absent (tests). */
  agentSettings?: () => AgentSettings
  /** Live tool-risk overrides threaded into every session (consulted per call). */
  toolRisk?: () => Record<string, RiskLevel>
  /** Composed fresh on every getOrCreate (spec §1) — never latched, never memoized. */
  composeMcp?: () => Promise<ComposedMcp>
  /** Fired when a turn fails auth-shaped; index.ts calls authCache.onAuthFailure() to clear and broadcast. */
  onAuthFailure?: () => void
  /** Fired when a turn completes normally — proof the credentials work. */
  onAuthVerified?: () => void
  /** Open a panel in a given case/session (3b-2); AgentService binds case+session per session. */
  openPanel?: (
    caseSlug: string,
    sessionId: number,
    packId: string,
    windowId: string,
    evidenceId?: number
  ) => { ok: boolean; reason?: string; panel?: unknown }
  /** Capture a panel to evidence for a given case; AgentService binds the case per session. */
  capturePanel?: (
    caseSlug: string,
    packId: string,
    windowId: string
  ) => Promise<import('./capturePanel').CapturePanelEvidence>
  /** Live pack-declared panel commands (3b-2); read at each session construction. */
  panelCommandDecls?: () => PanelCommandDecl[]
  /** Fired by setCaseStatus after a non-closed→closed transition; enqueues distillation. */
  onCaseClosed?: (rec: CaseRecord) => void
  /** Fired after workspace_checkout materializes/switches a case worktree. */
  onWorktreeChanged?: (caseSlug: string) => void
  /** Dispatch a panel command to a case's open panel (3b-2); AgentService binds caseSlug per session. */
  dispatchPanelCommand?: (
    caseSlug: string,
    packId: string,
    windowId: string,
    cmd: string,
    args: unknown[]
  ) => Promise<unknown>
}

const defaultCreateQuery: CreateQueryFn = (args) =>
  query({ prompt: args.prompt as never, options: args.options as never }) as never

export class AgentService {
  private deps: Required<
    Pick<
      AgentServiceDeps,
      'db' | 'argusHome' | 'detection' | 'skillsRoots' | 'onEvent' | 'agentAccess'
    >
  > &
    AgentServiceDeps
  private sessions = new Map<string, CaseSession>()

  constructor(deps: AgentServiceDeps) {
    this.deps = { maxSessions: 3, createQuery: defaultCreateQuery, ...deps }
  }

  private keyOf(caseSlug: string, sessionId: number): string {
    return `${caseSlug}::${sessionId}`
  }

  private async getOrCreate(caseSlug: string, sessionId: number): Promise<CaseSession> {
    const key = this.keyOf(caseSlug, sessionId)

    // Validate before any side effects: sessionId is caller-provided (Task 5 threads it
    // from the renderer), so verify the row exists and actually belongs to this case —
    // a doomed request must never evict (reap) a legitimate live session below.
    const rec = getCase(this.deps.db, caseSlug)
    if (!rec) throw new Error(`Unknown case: ${caseSlug}`)
    const owner = this.deps.db
      .prepare(`SELECT case_id FROM sessions WHERE id = ?`)
      .get(sessionId) as { case_id: number } | undefined
    if (!owner || owner.case_id !== rec.id) {
      throw new Error(`Unknown session ${sessionId} for case ${caseSlug}`)
    }

    const as = this.deps.agentSettings?.()
    // Composed on EVERY call (spec §1/§2): connector config and credentials are re-derived
    // at the point of use, never latched. compose is NOT side-effect-free — it can perform
    // a network OAuth refresh and persist rotated tokens — but it never touches
    // this.sessions, so it cannot evict a live session. That's what makes it safe to run
    // here, between the validation guard above and the reap below.
    const mcp = await this.deps.composeMcp?.()
    const fingerprint = mcp?.fingerprint ?? ''

    const existing = this.sessions.get(key)
    if (existing && existing.state === 'running') {
      // Never tear down a turn in flight; the rebuild happens on the next idle send.
      if (existing.activeTurn || existing.mcpFingerprint === fingerprint) return existing
      // Connectors changed under a live session whose mcpServers map is frozen at
      // query() construction — rebuild it. The resume cursor below preserves history.
      await existing.stop('reconfigured')
      this.sessions.delete(key)
    } else if (existing) {
      this.sessions.delete(key)
    }

    // reap LRU idle session if at capacity
    const max = as?.maxSessions ?? this.deps.maxSessions ?? 3
    if (this.sessions.size >= max) {
      const idle = [...this.sessions.entries()]
        .filter(([, s]) => !s.activeTurn)
        .sort((a, b) => a[1].lastActivity - b[1].lastActivity)[0]
      if (idle) {
        await idle[1].stop('reaped')
        this.sessions.delete(idle[0])
      }
    }

    const cursor = sessionCursor(this.deps.db, sessionId)

    const access = this.deps.agentAccess()
    const resolvedSkills = materializeSessionSkills(this.deps.argusHome, caseSlug, access)
    // Nudge follows the resolution winner (a user-tier shadow's enabled state
    // governs), so one Skills-page toggle silences both skill and nudge.
    const contributeBack = resolvedSkills.some((s) => s.name === 'contribute-back' && s.enabled)

    const session = new CaseSession({
      db: this.deps.db,
      argusHome: this.deps.argusHome,
      detection: this.deps.detection,
      caseId: rec.id,
      caseSlug,
      sessionId,
      workspaceRoots: await workspaceSandboxRoots(this.deps.db, this.deps.argusHome, caseSlug),
      skillsRoots: this.deps.skillsRoots,
      personaFragments: [
        ...(this.deps.personaFragments?.() ?? []),
        ...(contributeBack ? [CONTRIBUTE_BACK_NUDGE] : [])
      ],
      packCliNames: this.deps.packCliNames?.() ?? [],
      emit: this.deps.onEvent,
      createQuery: this.deps.createQuery ?? defaultCreateQuery,
      resumeSdkSessionId: cursor,
      toolRisk: this.deps.toolRisk,
      agentAccess: this.deps.agentAccess,
      extraMcpServers: mcp?.servers,
      mcpSkipped: mcp?.skipped,
      mcpFingerprint: fingerprint,
      onAuthFailure: this.deps.onAuthFailure,
      onAuthVerified: this.deps.onAuthVerified,
      openPanel: this.deps.openPanel
        ? (packId, windowId, evidenceId) =>
            this.deps.openPanel!(caseSlug, sessionId, packId, windowId, evidenceId)
        : undefined,
      capturePanel: this.deps.capturePanel
        ? (packId, windowId) => this.deps.capturePanel!(caseSlug, packId, windowId)
        : undefined,
      onCaseClosed: this.deps.onCaseClosed,
      onWorktreeChanged: this.deps.onWorktreeChanged,
      panelCommandDecls: this.deps.panelCommandDecls?.(),
      dispatchPanelCommand: this.deps.dispatchPanelCommand
        ? (packId, windowId, cmd, args) =>
            this.deps.dispatchPanelCommand!(caseSlug, packId, windowId, cmd, args)
        : undefined,
      agentOptions: as
        ? (() => {
            const parsed = settingsSchema.parse({ agent: as })
            const cfg = activeInstanceConfig(parsed)
            return {
              // explicit config.model wins (back-compat); else the top ordered visible model
              model: cfg.model ?? effectiveDefaultModel(parsed),
              cliPath: cfg.cliPath,
              permissionMode: as.defaultPermissionMode,
              personaAppend: as.personaAppend || undefined
            }
          })()
        : undefined
    })
    if (this.deps.mirrorFactory) {
      // mirror is attached post-construction to keep SessionDeps simple
      ;(session as unknown as { deps: { mirror?: SessionMirrorLike } }).deps.mirror =
        this.deps.mirrorFactory(caseSlug, sessionId)
    }
    this.sessions.set(key, session)
    return session
  }

  async send(caseSlug: string, sessionId: number, text: string): Promise<number> {
    const s = await this.getOrCreate(caseSlug, sessionId)
    return s.send(text)
  }

  async emitPanelFinding(
    caseSlug: string,
    sessionId: number,
    input: { title: string; markdown: string }
  ): Promise<{ ok: boolean; findingId?: number }> {
    const s = await this.getOrCreate(caseSlug, sessionId)
    return s.emitPanelFinding(input)
  }

  async ingestPanelEvidence(
    caseSlug: string,
    sessionId: number,
    input: { source: { url: string } | { bytes: Buffer }; filename: string }
  ): Promise<{ ok: true; evidenceId: string } | { ok: false; reason: string }> {
    const s = await this.getOrCreate(caseSlug, sessionId)
    return s.ingestPanelEvidence(input)
  }

  respond(caseSlug: string, sessionId: number, d: ApprovalDecision): boolean {
    return this.sessions.get(this.keyOf(caseSlug, sessionId))?.respond(d) ?? false
  }

  async interrupt(caseSlug: string, sessionId: number): Promise<void> {
    await this.sessions.get(this.keyOf(caseSlug, sessionId))?.interrupt()
  }

  async stopAll(): Promise<void> {
    for (const [key, s] of [...this.sessions.entries()]) {
      await s.stop('stopped')
      this.sessions.delete(key)
    }
  }

  /** Stop + evict one live session (chat deletion); no-op when not live. */
  async stopSession(caseSlug: string, sessionId: number): Promise<void> {
    const key = this.keyOf(caseSlug, sessionId)
    const s = this.sessions.get(key)
    if (!s) return
    await s.stop('stopped')
    this.sessions.delete(key)
  }

  /** Stop + evict every live session of a case (case deletion). The `::`
   *  suffix keeps the prefix match exact — NAV-1 never matches NAV-10. */
  async stopAllForCase(caseSlug: string): Promise<void> {
    for (const [key, s] of [...this.sessions.entries()]) {
      if (key.startsWith(`${caseSlug}::`)) {
        await s.stop('stopped')
        this.sessions.delete(key)
      }
    }
  }

  states(): { caseSlug: string; sessionId: number; state: string; activeTurn: boolean }[] {
    return [...this.sessions.entries()].map(([key, s]) => ({
      caseSlug: key.slice(0, key.length - `::${s.sessionId}`.length),
      sessionId: s.sessionId,
      state: s.state,
      activeTurn: s.activeTurn
    }))
  }
}
