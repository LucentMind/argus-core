import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent } from '../../../shared/agent-events'
import type { ApprovalDecision, CaseRecord, DialogAnswer } from '../../../shared/types'
import type { ModeId } from '../../../shared/modes'
import type { ComposedMcp, RiskLevel } from '../../../shared/connectors'
import type { RunOptionSelection } from '../../../shared/runOptions'
import {
  activeInstanceConfig,
  driverConfig,
  effectiveDefaultModel,
  orderedVisibleModels,
  type AgentDriverConfig
} from '../../../shared/drivers'
import { settingsSchema, type AgentSettings } from '../../../shared/settings'
import type { AgentAccess } from '../../../shared/agentAccess'
import { CaseSession, ownerKeyOf, type SessionMirrorLike } from './session'
import type { AgentDriver } from './driver'
import type { ProcessLabels } from '../diagnostics/processLabels'
import { createClaudeDriver, type CreateQueryFn } from './drivers/claude'
import type { PanelCommandDecl } from './panelCommands'
import {
  sessionCursor,
  sessionProvider,
  sessionMode,
  sessionRunOptions,
  sessionPermissionMode
} from './sessionStore'
import { getCase } from '../caseService'
import { workspaceSandboxRoots } from '../workspaces'
import { materializeSessionSkills } from './skillsResolver'
import { assembleMode } from './modeAssembly'
import type { Detection } from '../packs/detection'
import type { SessionPromptCapture } from '../../../shared/promptsIpc'
import { driverForSession } from './reviewFraming'
import type { Runner } from '../github'
import type { NativeToolDeps } from './nativeTools'

/**
 * Cache key for everything that is frozen at `query()` construction besides the model:
 * effort, the [1m] suffix, the settings object and the permission mode. Sorted so a
 * reordered array is not mistaken for a change.
 */
export function optionsKeyOf(
  sel: readonly RunOptionSelection[],
  permissionMode: string | null
): string {
  const sorted = [...sel].sort((a, b) => a.id.localeCompare(b.id))
  return `${JSON.stringify(sorted)}::${permissionMode ?? ''}`
}

export interface AgentServiceDeps {
  db: DatabaseSync
  argusHome: string
  detection: Detection
  skillsRoots: string[]
  /** Live pack persona fragments (PackRegistry); read at each session construction. */
  personaFragments?: () => string[]
  /** Prompt-visible index of team references; read at each session construction. A thunk
   *  because both the references directory and the routing config it reads live in index.ts,
   *  and the answer must reflect whatever is on disk right now. */
  referenceIndex?: () => string
  /** Live pack-declared CLI binary names (PackRegistry); read at each session construction. */
  packCliNames?: () => string[]
  onEvent: (e: AgentEvent) => void
  /** Live agent-access overrides (skills/memory); consulted at each session construction. */
  agentAccess: () => AgentAccess
  /** The agent driver every session runs on; defaults to the Claude driver. A thunk is
   *  re-invoked at every `getOrCreate` (session construction) so switching the active
   *  provider in settings takes effect on the NEXT session, without an app restart. A
   *  plain value is treated as a fixed driver, resolved once (back-compat). */
  driver?: AgentDriver | (() => AgentDriver)
  /** Resolves the driver for a session pinned to a specific provider instance. Kept as a
   *  dep (not a direct driverRegistry call) so it stays on the same injection seam as
   *  `driver` — reaching into the global registry here would bypass `createQuery` and boot
   *  a real SDK transport under tests. Absent ⇒ fall back to `driver`. */
  driverForInstance?: (instanceId: string) => AgentDriver
  /** Back-compat test seam: when only `createQuery` is given, it is wrapped in the Claude
   *  driver (`createClaudeDriver(createQuery)`). Ignored when `driver` is supplied. */
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
  /** Capture a panel to evidence for a given case; AgentService binds the case + mode per
   *  session (a review session's capture must land in artifacts/, not evidence/). */
  capturePanel?: (
    caseSlug: string,
    packId: string,
    windowId: string,
    mode: ModeId
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
  /** Prompt-registry resolver; forwarded to assembleMode and each CaseSession. */
  resolvePrompt?: (id: string) => string
  /** GUARD 4 input: active prompt override ids, read per session construction. */
  activeOverrides?: () => string[]
  /** Sink for session prompt captures; absent when the dev-tools gate is off. */
  recordPromptCapture?: (c: SessionPromptCapture) => void
  /** gh runner for the review write tools (nativeTools + postFindingComment). Injected in
   *  tests; production leaves it undefined so every call falls back to `defaultGhRunner`. */
  gh?: Runner
  /** Multi-source known-defects search (DefectCorpusService.searchAll); threaded into every
   *  session's nativeToolDeps unchanged — the tool needs no per-case/session binding. */
  defectCorpus?: NativeToolDeps['defectCorpus']
  /** Tier-A diagnostics registry; forwarded to every CaseSession so a driver's spawn-site
   *  pid (ACP/Codex) can be registered against its case/session. Absent = no registration
   *  (tests that don't construct a diagnostics registry). */
  processLabels?: ProcessLabels
  /** Why this session may not be attached to right now, or null. Injected (not a routines
   *  import) so AgentService keeps knowing nothing about routines; index.ts binds
   *  `runningRoutineForSession`. See the guard in getOrCreate. */
  sessionUnavailable?: (sessionId: number) => string | null
}

export class AgentService {
  private deps: Required<
    Pick<
      AgentServiceDeps,
      'db' | 'argusHome' | 'detection' | 'skillsRoots' | 'onEvent' | 'agentAccess'
    >
  > &
    AgentServiceDeps
  /** Back-compat fallback when `deps.driver` is absent: the (optional) createQuery seam
   *  wrapped in the Claude driver, resolved once — createClaudeDriver falls back to the
   *  real SDK query() when createQuery is undefined (production). Only used when
   *  `deps.driver` is not given at all; a plain-value or thunk `deps.driver` always wins. */
  private fallbackDriver: AgentDriver
  private sessions = new Map<string, CaseSession>()

  constructor(deps: AgentServiceDeps) {
    this.deps = { maxSessions: 3, ...deps }
    this.fallbackDriver = createClaudeDriver(deps.createQuery)
  }

  /** Re-resolved on every call (not cached): a thunk `deps.driver` picks up the live
   *  active provider on each new session; a plain-value `deps.driver` or the constructor's
   *  memoized fallback behave exactly as the old once-resolved `this.driver` did. */
  private resolveDriver(): AgentDriver {
    const d = this.deps.driver
    if (typeof d === 'function') return d()
    return d ?? this.fallbackDriver
  }

  private keyOf(caseSlug: string, sessionId: number): string {
    return `${caseSlug}::${sessionId}`
  }

  /** Recover the caseSlug from an internal session-map key. Length-subtraction
   *  rather than `split('::')`, because a slug may itself contain `::`. */
  private caseSlugOf(key: string, sessionId: number): string {
    return key.slice(0, key.length - `::${sessionId}`.length)
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

    // Some sessions are owned by something other than this map. A routine's background session
    // never enters `this.sessions`, so without this guard the lookup below would miss and we
    // would silently construct a SECOND CaseSession on the same session row — this one fully
    // permissioned, with connectors, resuming from the same cursor, writing the same mirror and
    // the same turns/tool_calls rows, and torn down by the routine's own `stop()` mid-chat.
    // Placed after the ownership check (so a bogus request still gets the more specific error)
    // and before ANY side effect: composeMcp below can perform a network OAuth refresh, and the
    // reap can stop a live session — neither should happen for a request that is about to be
    // refused. Throws rather than no-ops: this reaches the renderer as the send's rejection,
    // which is the only place the user can be told why their message went nowhere.
    const unavailable = this.deps.sessionUnavailable?.(sessionId)
    if (unavailable) throw new Error(unavailable)

    const as = this.deps.agentSettings?.()
    // Composed on EVERY call (spec §1/§2): connector config and credentials are re-derived
    // at the point of use, never latched. compose is NOT side-effect-free — it can perform
    // a network OAuth refresh and persist rotated tokens — but it never touches
    // this.sessions, so it cannot evict a live session. That's what makes it safe to run
    // here, between the validation guard above and the reap below.
    const mcp = await this.deps.composeMcp?.()
    const fingerprint = mcp?.fingerprint ?? ''

    // The provider/model this session is pinned to (nulls for pre-multi-provider rows,
    // which keep resolving from settings exactly as before).
    const pinned = sessionProvider(this.deps.db, sessionId)
    const modelKey = `${pinned?.instanceId ?? ''}::${pinned?.model ?? ''}`
    // Read BEFORE the early-return guard below — mode must participate in the rebuild
    // decision exactly like modelKey and mcpFingerprint do.
    const mode = sessionMode(this.deps.db, sessionId)
    // effort, the [1m] suffix, settings and permissionMode are ALSO frozen at query()
    // construction (Claude driver), exactly like modelKey — so they must participate in
    // the same rebuild decision or a Reasoning/permission-mode change on a warm session
    // is silently ignored.
    const runOptions = sessionRunOptions(this.deps.db, sessionId)
    const sessionPerm = sessionPermissionMode(this.deps.db, sessionId)
    const optionsKey = optionsKeyOf(runOptions, sessionPerm)

    const existing = this.sessions.get(key)
    if (existing && existing.state === 'running') {
      // Never tear down a turn in flight; the rebuild happens on the next idle send.
      if (existing.activeTurn) return existing
      // A live session's mcpServers map, its model, mode (persona + skill allowlist),
      // AND its run options / permission mode are frozen at query() construction. Mode
      // has no in-app path that changes it under a live session — a session's mode is
      // written only at INSERT (setSessionMode was removed; Plan 1b made mode a
      // case-level axis, sessions just bind to it at creation) — but the guard is kept
      // anyway as free defence-in-depth: registry.mode.test.ts exercises it via a direct
      // DB UPDATE, standing in for a future code path or a hand-edited row. The resume
      // cursor below preserves history (and is invalidated by sessionCursor's guard if
      // the driver kind changed).
      if (
        existing.mcpFingerprint === fingerprint &&
        existing.modelKey === modelKey &&
        existing.mode === mode &&
        existing.optionsKey === optionsKey
      )
        return existing
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

    // A session pinned to an instance resolves ITS driver; an unpinned (pre-multi-provider)
    // session falls back to the thunk, which picks up the live default provider — so
    // switching the default in settings still takes effect for those on the next construct.
    // `driverForSession` is the shared rule (reviewFraming.ts) — the review-run composer
    // resolves the same session's driver through the identical call, so the two answer "which
    // driver is this session actually on" the same way instead of each keeping its own copy of
    // the fallback logic.
    const driver = driverForSession(
      {
        db: this.deps.db,
        driverForInstance: this.deps.driverForInstance,
        resolveDriver: () => this.resolveDriver()
      },
      sessionId
    )
    const cursor = sessionCursor(this.deps.db, sessionId, driver.kind, pinned?.instanceId)

    const access = this.deps.agentAccess()
    const resolvedSkills = materializeSessionSkills(this.deps.argusHome, caseSlug, access)
    // Nudge follows the resolution winner (a user-tier shadow's enabled state
    // governs), so one Skills-page toggle silences both skill and nudge.
    const contributeBack = resolvedSkills.some((s) => s.name === 'contribute-back' && s.enabled)
    const assembled = assembleMode({
      mode,
      resolvedSkills,
      packFragments: this.deps.personaFragments?.() ?? [],
      contributeBack,
      resolve: this.deps.resolvePrompt
    })

    const session = new CaseSession({
      db: this.deps.db,
      argusHome: this.deps.argusHome,
      detection: this.deps.detection,
      caseId: rec.id,
      caseSlug,
      sessionId,
      workspaceRoots: await workspaceSandboxRoots(this.deps.db, this.deps.argusHome, caseSlug),
      skillsRoots: this.deps.skillsRoots,
      // The same resolution that materialized the junctions also bounds what the driver
      // may load — a linked workspace's own .claude/skills must never enter the session.
      enabledSkills: assembled.enabledSkills,
      personaFragments: assembled.personaFragments,
      skillIndex: assembled.skillIndex,
      // Not from assembleMode: unlike the skill index this has no mode dimension — a reference
      // is relevant to a case, not to a role.
      referenceIndex: this.deps.referenceIndex?.() ?? '',
      personaFragmentIds: assembled.personaFragmentIds,
      activeOverrides: this.deps.activeOverrides,
      recordPromptCapture: this.deps.recordPromptCapture,
      packCliNames: this.deps.packCliNames?.() ?? [],
      resolvePrompt: this.deps.resolvePrompt,
      emit: this.deps.onEvent,
      driver,
      resumeCursor: cursor,
      toolRisk: this.deps.toolRisk,
      agentAccess: this.deps.agentAccess,
      extraMcpServers: mcp?.servers,
      mcpSkipped: mcp?.skipped,
      mcpFingerprint: fingerprint,
      onAuthFailure: this.deps.onAuthFailure,
      onAuthVerified: this.deps.onAuthVerified,
      gh: this.deps.gh,
      openPanel: this.deps.openPanel
        ? (packId, windowId, evidenceId) =>
            this.deps.openPanel!(caseSlug, sessionId, packId, windowId, evidenceId)
        : undefined,
      capturePanel: this.deps.capturePanel
        ? (packId, windowId) => this.deps.capturePanel!(caseSlug, packId, windowId, mode)
        : undefined,
      onCaseClosed: this.deps.onCaseClosed,
      onWorktreeChanged: this.deps.onWorktreeChanged,
      defectCorpus: this.deps.defectCorpus,
      processLabels: this.deps.processLabels,
      // stopSession() stops AND evicts; a bare session.stop() would leave the dead
      // session in this.sessions where getOrCreate could hand it back out.
      stopSelf: () => this.stopSession(caseSlug, sessionId),
      panelCommandDecls: this.deps.panelCommandDecls?.(),
      dispatchPanelCommand: this.deps.dispatchPanelCommand
        ? (packId, windowId, cmd, args) =>
            this.deps.dispatchPanelCommand!(caseSlug, packId, windowId, cmd, args)
        : undefined,
      modelKey,
      optionsKey,
      mode,
      agentOptions: as
        ? (() => {
            const parsed = settingsSchema.parse({ agent: as })
            // A pinned session reads ITS instance's config; an unpinned one keeps the old
            // default-instance behaviour.
            const cfg = pinned?.instanceId
              ? driverConfig<AgentDriverConfig>(
                  parsed.agent.providerInstances[pinned.instanceId]?.driver ?? '',
                  parsed.agent.providerInstances[pinned.instanceId]?.config
                )
              : activeInstanceConfig(parsed)
            return {
              // The session's own model wins; then explicit config.model (back-compat);
              // else the top ordered visible model of whichever instance applies.
              model:
                pinned?.model ??
                cfg.model ??
                (pinned?.instanceId
                  ? orderedVisibleModels(parsed, pinned.instanceId)[0]?.slug
                  : effectiveDefaultModel(parsed)),
              cliPath: cfg.cliPath,
              // The session's own mode wins; the settings default is the fallback for
              // sessions that never set one.
              permissionMode: sessionPerm ?? as.defaultPermissionMode,
              runOptions,
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

  async send(
    caseSlug: string,
    sessionId: number,
    text: string,
    opts?: { composed?: boolean }
  ): Promise<number> {
    const s = await this.getOrCreate(caseSlug, sessionId)
    return s.send(text, opts)
  }

  async emitPanelFinding(
    caseSlug: string,
    sessionId: number,
    input: { title: string; markdown: string }
  ): Promise<{ ok: boolean; findingId?: number }> {
    const s = await this.getOrCreate(caseSlug, sessionId)
    return s.emitPanelFinding(input)
  }

  async postFindingComment(
    caseSlug: string,
    sessionId: number,
    findingId: number
  ): Promise<{ ok: boolean; reason?: string }> {
    const s = await this.getOrCreate(caseSlug, sessionId)
    return s.postFindingComment(findingId)
  }

  async ingestPanelEvidence(
    caseSlug: string,
    sessionId: number,
    input: { source: { url: string } | { bytes: Buffer }; filename: string }
  ): Promise<{ ok: true; evidenceId: string; relPath: string } | { ok: false; reason: string }> {
    const s = await this.getOrCreate(caseSlug, sessionId)
    return s.ingestPanelEvidence(input)
  }

  respond(caseSlug: string, sessionId: number, d: ApprovalDecision): boolean {
    return this.sessions.get(this.keyOf(caseSlug, sessionId))?.respond(d) ?? false
  }

  answerDialog(caseSlug: string, sessionId: number, a: DialogAnswer): boolean {
    return this.sessions.get(this.keyOf(caseSlug, sessionId))?.answerDialog(a) ?? false
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
      caseSlug: this.caseSlugOf(key, s.sessionId),
      sessionId: s.sessionId,
      state: s.state,
      activeTurn: s.activeTurn
    }))
  }

  /**
   * Keys of every live session, for diagnostics orphan detection — one per entry in
   * `this.sessions`, in the `ownerKeyOf` format CaseSession registers as `owner` at
   * driver spawn (session.ts), NOT this class's own internal map key (`keyOf`, which
   * uses `::` for stopAllForCase's exact-prefix match and is a different concept).
   * caseSlug is recovered the same way `states()` does, from the internal key.
   */
  liveOwnerKeys(): string[] {
    return [...this.sessions.entries()].map(([key, s]) =>
      ownerKeyOf(this.caseSlugOf(key, s.sessionId), s.sessionId)
    )
  }
}
