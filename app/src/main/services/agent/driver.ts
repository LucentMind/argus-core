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
}

export interface ProbeAuthResult {
  ok: boolean
  detail: string
}

export interface AgentDriver {
  readonly kind: DriverKind
  readonly toolTaxonomy: ToolTaxonomy
  readonly capabilities: DriverCapabilities
  createSession(ctx: DriverSessionContext): DriverSession
  probeAuth(config: { cliPath?: string; timeoutMs?: number }): Promise<ProbeAuthResult>
}
