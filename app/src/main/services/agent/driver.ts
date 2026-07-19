import type { AgentEvent } from '../../../shared/agent-events'
import type { PermissionMode } from '../../../shared/settings'
import type { ToolTaxonomy } from './risk'
import type { NativeToolDeps } from './nativeTools'
import type { PanelCommandDecl } from './panelCommands'

export type DriverKind = 'claude-agent-sdk' | 'github-copilot'

export interface EventCtx {
  caseId: number
  caseSlug: string
  sessionId: number
  turnId: number | null
}

export interface TurnResult {
  isError: boolean
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  durationMs: number | null
  model: string | null
  authFailure: boolean
}

export type ToolDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

export interface DriverSessionContext {
  caseDir: string
  additionalDirectories: readonly string[]
  /**
   * Names of the skills Argus resolved as enabled — the ONLY skills a session may load.
   * Passed to the driver as an explicit allowlist because `additionalDirectories` entries
   * are scanned for `.claude/skills` by the Claude CLI: a linked code workspace is an
   * investigation artifact, and a repo that ships its own skills would otherwise inject
   * them into the session, bypassing the tier precedence and the Skills page. An empty
   * array means "no skills" — it must still be sent, since omitting the allowlist falls
   * back to the CLI's discover-everything default.
   */
  skills: readonly string[]
  model?: string
  cliPath?: string
  permissionMode: PermissionMode
  /** Persona + memory-index text the driver injects as its system-prompt append. */
  systemAppend: string
  /** Composed connector servers (opaque passthrough for Claude; Copilot serializes). */
  extraMcpServers: Record<string, unknown>
  nativeToolDeps: NativeToolDeps
  panelCommandDecls: PanelCommandDecl[]
  dispatchPanelCommand?: (
    packId: string,
    windowId: string,
    cmd: string,
    args: unknown[]
  ) => Promise<unknown>
  resumeCursor: string | null
  /** Live per-message event context (turnId moves between turns). */
  eventCtx: () => EventCtx
  /** The harness approval pipeline; the driver adapts its SDK callback onto this. */
  onToolRequest: (
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal }
  ) => Promise<ToolDecision>
  /** Durable resume cursor observed on the stream. */
  onCursor: (cursor: string) => void
  /** Per-turn accounting + auth verdict, extracted by the driver. */
  onTurnResult: (r: TurnResult) => void
  /**
   * Classification-only seam: run the harness risk classifier for a tool WITHOUT opening an
   * approval card, returning just the verdict action. Used by permission-mode short-circuits
   * that suppress the *ask* but must still honor a *deny* (Copilot `acceptEdits`: a write to
   * an out-of-sandbox / read-only-root path is still rejected). Claude ignores it (its SDK
   * enforces acceptEdits internally). Optional so drivers/tests without it are unaffected.
   */
  classifyOnly?: (
    toolName: string,
    input: Record<string, unknown>
  ) => { action: 'allow' | 'ask' | 'deny'; reason?: string }
}

export interface DriverSession {
  /** Continuous normalized stream; ends when the underlying session ends. */
  events(): AsyncIterable<AgentEvent>
  /** Enqueue a user prompt (driver wraps it in its SDK envelope). */
  send(text: string): void
  interrupt(): Promise<void>
  /** End the prompt queue so events() completes. */
  end(): void
}

export interface DriverCapabilities {
  permissionModes: readonly PermissionMode[]
  editableApprovals: boolean
  costReporting: boolean
  /** Whether the driver can expose Argus connector (external MCP) servers to the agent.
   *  Absent = supported (Claude). `false` = declared degradation (Copilot v1): connector
   *  tools are unavailable and each composed server is reported via `session.mcp.skipped`. */
  mcpConnectors?: boolean
}

export interface ProbeAuthResult {
  ok: boolean
  detail: string
  /** Account identity, when the probe surfaced one (same fields as `AuthStatus`, minus
   *  `verified` — a probe alone never proves credentials work; only a real turn does). */
  email?: string
  subscription?: string
  version?: string
}

export interface AgentDriver {
  readonly kind: DriverKind
  readonly toolTaxonomy: ToolTaxonomy
  readonly capabilities: DriverCapabilities
  /** Remediation shown on the Health screen's "Agent auth" row when `probeAuth` fails.
   *  Driver-owned because the fix is vendor-specific — telling a Copilot user to run
   *  `claude login` is worse than saying nothing. */
  readonly authFixHint: string
  /** Shell command that installs/updates this driver's CLI, shown in the update advisory.
   *  Driver-owned because the package differs per vendor. */
  readonly updateCommand?: string
  /** npm package whose `latest` dist-tag is this CLI's published version. Absent = no
   *  update check for this driver (the advisory simply never appears). */
  readonly npmPackage?: string
  createSession(ctx: DriverSessionContext): DriverSession
  probeAuth(config: { cliPath?: string; timeoutMs?: number }): Promise<ProbeAuthResult>
  /**
   * Optional driver-specific classifier for whether a thrown/consumed error message is an
   * auth failure. CaseSession's consume-catch prefers this when present (Copilot reports
   * auth failure through a typed `session.error` channel AND a leaked message substring);
   * absent, callers fall back to the Claude `isAuthFailure` heuristic.
   */
  isAuthErrorMessage?(message: string): boolean
}
