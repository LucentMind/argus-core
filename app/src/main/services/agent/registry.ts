import type { DatabaseSync } from 'node:sqlite'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent } from '../../../shared/agent-events'
import type { ApprovalDecision } from '../../../shared/types'
import type { ComposedMcp, RiskLevel } from '../../../shared/connectors'
import { activeInstanceConfig, effectiveDefaultModel } from '../../../shared/drivers'
import { settingsSchema, type AgentSettings } from '../../../shared/settings'
import type { AgentAccess } from '../../../shared/agentAccess'
import { CaseSession, type CreateQueryFn, type SessionMirrorLike } from './session'
import { createSession, sessionCursor } from './sessionStore'
import { getCase } from '../caseService'
import { workspaceSandboxRoots } from '../workspaces'
import { materializeSessionSkills } from './skillsResolver'

export interface AgentServiceDeps {
  db: DatabaseSync
  argusHome: string
  skillsRoots: string[]
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
  /** Composed per session construction (new sessions only), like agentSettings. */
  composeMcp?: () => ComposedMcp
}

const defaultCreateQuery: CreateQueryFn = (args) =>
  query({ prompt: args.prompt as never, options: args.options as never }) as never

export class AgentService {
  private deps: Required<
    Pick<AgentServiceDeps, 'db' | 'argusHome' | 'skillsRoots' | 'onEvent' | 'agentAccess'>
  > &
    AgentServiceDeps
  private sessions = new Map<string, CaseSession>()

  constructor(deps: AgentServiceDeps) {
    this.deps = { maxSessions: 3, createQuery: defaultCreateQuery, ...deps }
  }

  private async getOrCreate(caseSlug: string): Promise<CaseSession> {
    const existing = this.sessions.get(caseSlug)
    if (existing && existing.state === 'running') return existing
    if (existing) this.sessions.delete(caseSlug)

    const as = this.deps.agentSettings?.()
    const mcp = this.deps.composeMcp?.()

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

    const rec = getCase(this.deps.db, caseSlug)
    if (!rec) throw new Error(`Unknown case: ${caseSlug}`)
    // WP-D: sessions.case_id lost its UNIQUE constraint (multi-session per case), but the
    // registry still exposes one running session per case (Task 4 adds multi-session UI) —
    // create-or-reuse that single row here since CaseSession no longer does it itself.
    const existingSession = this.deps.db
      .prepare(`SELECT id FROM sessions WHERE case_id = ?`)
      .get(rec.id) as { id: number } | undefined
    const sessionId = existingSession?.id ?? createSession(this.deps.db, caseSlug).id
    const cursor = sessionCursor(this.deps.db, sessionId)

    const access = this.deps.agentAccess()
    materializeSessionSkills(this.deps.argusHome, caseSlug, access)

    const session = new CaseSession({
      db: this.deps.db,
      argusHome: this.deps.argusHome,
      caseId: rec.id,
      caseSlug,
      sessionId,
      workspaceRoots: await workspaceSandboxRoots(this.deps.db, this.deps.argusHome, caseSlug),
      skillsRoots: this.deps.skillsRoots,
      emit: this.deps.onEvent,
      createQuery: this.deps.createQuery ?? defaultCreateQuery,
      resumeSdkSessionId: cursor,
      toolRisk: this.deps.toolRisk,
      agentAccess: this.deps.agentAccess,
      extraMcpServers: mcp?.servers,
      mcpSkipped: mcp?.skipped,
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
        this.deps.mirrorFactory(caseSlug, session.sessionId)
    }
    this.sessions.set(caseSlug, session)
    return session
  }

  async send(caseSlug: string, text: string): Promise<void> {
    const s = await this.getOrCreate(caseSlug)
    s.send(text)
  }

  respond(caseSlug: string, d: ApprovalDecision): boolean {
    return this.sessions.get(caseSlug)?.respond(d) ?? false
  }

  async interrupt(caseSlug: string): Promise<void> {
    await this.sessions.get(caseSlug)?.interrupt()
  }

  async stopAll(): Promise<void> {
    for (const [slug, s] of [...this.sessions.entries()]) {
      await s.stop('stopped')
      this.sessions.delete(slug)
    }
  }

  states(): { caseSlug: string; state: string; activeTurn: boolean }[] {
    return [...this.sessions.entries()].map(([caseSlug, s]) => ({
      caseSlug,
      state: s.state,
      activeTurn: s.activeTurn
    }))
  }
}
