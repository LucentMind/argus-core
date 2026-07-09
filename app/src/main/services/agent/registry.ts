import type { DatabaseSync } from 'node:sqlite'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent } from '../../../shared/agent-events'
import type { ApprovalDecision } from '../../../shared/types'
import { CaseSession, type CreateQueryFn, type SessionMirrorLike } from './session'
import { getCase } from '../caseService'
import { workspaceSandboxRoots } from '../workspaces'

export interface AgentServiceDeps {
  db: DatabaseSync
  argusHome: string
  skillsRoots: string[]
  onEvent: (e: AgentEvent) => void
  createQuery?: CreateQueryFn
  maxSessions?: number
  mirrorFactory?: (caseSlug: string, sessionId: number) => SessionMirrorLike
}

const defaultCreateQuery: CreateQueryFn = (args) =>
  query({ prompt: args.prompt as never, options: args.options as never }) as never

export class AgentService {
  private deps: Required<Pick<AgentServiceDeps, 'db' | 'argusHome' | 'skillsRoots' | 'onEvent'>> &
    AgentServiceDeps
  private sessions = new Map<string, CaseSession>()

  constructor(deps: AgentServiceDeps) {
    this.deps = { maxSessions: 3, createQuery: defaultCreateQuery, ...deps }
  }

  private async getOrCreate(caseSlug: string): Promise<CaseSession> {
    const existing = this.sessions.get(caseSlug)
    if (existing && existing.state === 'running') return existing
    if (existing) this.sessions.delete(caseSlug)

    // reap LRU idle session if at capacity
    const max = this.deps.maxSessions ?? 3
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
    const cursor = this.deps.db
      .prepare(`SELECT sdk_session_id FROM sessions WHERE case_id = ?`)
      .get(rec.id) as { sdk_session_id: string | null } | undefined

    const session = new CaseSession({
      db: this.deps.db,
      argusHome: this.deps.argusHome,
      caseId: rec.id,
      caseSlug,
      workspaceRoots: await workspaceSandboxRoots(this.deps.db, this.deps.argusHome, caseSlug),
      skillsRoots: this.deps.skillsRoots,
      emit: this.deps.onEvent,
      createQuery: this.deps.createQuery ?? defaultCreateQuery,
      resumeSdkSessionId: cursor?.sdk_session_id ?? null
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
