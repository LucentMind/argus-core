import path from 'node:path'
import type { RawSdkEvent } from './normalize'

/**
 * Structural surface of a Copilot SDK session that the driver relies on. Kept minimal
 * (and structural, not a `CopilotSession` import) so the driver's unit/contract tests can
 * inject a scripted fake at the `client.ts` seam without booting the bundled runtime.
 */
export interface CopilotSessionLike {
  readonly sessionId: string
  /** Subscribe to ALL session events; returns an unsubscribe fn. */
  on(handler: (event: RawSdkEvent) => void): () => void
  /** Enqueue a prompt; the SDK processes it asynchronously and streams via `on`. */
  send(options: { prompt: string }): Promise<string>
  /** Request cancellation of the in-flight turn. */
  abort(): Promise<void>
  /** Per-session RPC surface. Plan mode is engaged via `rpc.mode.set` (EVIDENCE §9).
   *  Optional/structural so scripted fakes need not provide it. */
  rpc?: { mode?: { set?: (req: { mode: string }) => Promise<unknown> } }
}

/** Result of the exit-plan-mode handshake (SDK `ExitPlanModeResult`, EVIDENCE §9). */
export interface CopilotExitPlanModeResult {
  approved: boolean
  selectedAction?: string
  feedback?: string
}

/** A native/panel tool bound via `SessionConfig.tools` (SDK `Tool`/`defineTool`, EVIDENCE §4).
 *  `parameters` is a Zod schema (`z.object(...)`, accepted per evidence) or a raw JSON schema. */
export interface CopilotToolDef {
  name: string
  description: string
  parameters: unknown
  /** LOW-risk tools bypass the permission channel, mirroring Claude's auto-allow. */
  skipPermission?: boolean
  handler: (args: Record<string, unknown>, invocation?: unknown) => Promise<unknown>
}

export interface CopilotAuthStatus {
  isAuthenticated: boolean
  authType?: string
  host?: string
  login?: string
  statusMessage?: string
}

/** Session config the driver hands to create/resume (a subset of the SDK's SessionConfig). */
export interface CopilotSessionConfig {
  workingDirectory: string
  systemMessage: { mode: 'append'; content: string }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onPermissionRequest: (request: any, invocation: { sessionId: string }) => Promise<any>
  /** Native + panel tools exposed to the agent (Task 9B). */
  tools?: CopilotToolDef[]
  /** Directories to load skills from — the materialized `<caseDir>/.claude/skills` junctions
   *  (Task 10; EVIDENCE §11/§11b). Loads the same `<name>/SKILL.md` shape skillsResolver.ts
   *  already produces; omitted entirely when the case has no skills dir. */
  skillDirectories?: string[]
  /** Approve/deny the agent's request to leave plan mode (Task 9B; EVIDENCE §9). */
  onExitPlanModeRequest?: (
    request: {
      summary?: string
      planContent?: string
      actions?: string[]
      recommendedAction?: string
    },
    invocation: { sessionId: string }
  ) => Promise<CopilotExitPlanModeResult> | CopilotExitPlanModeResult
}

export interface CopilotClientLike {
  /** Boot the runtime transport; MUST be awaited before getAuthStatus/create/resume. */
  start(): Promise<void>
  createSession(config: CopilotSessionConfig): Promise<CopilotSessionLike>
  resumeSession(sessionId: string, config: CopilotSessionConfig): Promise<CopilotSessionLike>
  getAuthStatus(): Promise<CopilotAuthStatus>
  getStatus(): Promise<{ version?: string; protocolVersion?: number }>
  /** Graceful runtime shutdown; returns any teardown errors. */
  stop(): Promise<Error[]>
  /** Forceful shutdown for the error path — never leave an orphaned runtime. */
  forceStop(): Promise<void>
}

export interface CopilotClientOpts {
  /** COPILOT_HOME for the spawned runtime — isolated under the app's home dir. */
  baseDirectory: string
  /** The session cwd (the case directory). */
  workingDirectory: string
  /** Optional custom CLI binary path (→ COPILOT_CLI_PATH). */
  cliPath?: string
}

export type CopilotClientFactory = (opts: CopilotClientOpts) => CopilotClientLike

/** Derive the isolated COPILOT_HOME from the app's argus home dir. */
export function copilotHome(argusHome: string): string {
  return path.join(argusHome, 'copilot-home')
}

/**
 * The production factory: lazily requires `@github/copilot-sdk` (a runtime dependency of
 * the Electron main process) so importing this module never pulls the SDK into unit tests
 * that inject a fake. One client per DriverSession is acceptable for v1; runtime pooling
 * across sessions is a future concern.
 */
export const defaultClientFactory: CopilotClientFactory = (opts) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@github/copilot-sdk') as {
    CopilotClient: new (options: Record<string, unknown>) => CopilotClientLike
  }
  return new mod.CopilotClient({
    baseDirectory: opts.baseDirectory,
    workingDirectory: opts.workingDirectory,
    logLevel: 'error',
    ...(opts.cliPath ? { env: { COPILOT_CLI_PATH: opts.cliPath } } : {})
  })
}
