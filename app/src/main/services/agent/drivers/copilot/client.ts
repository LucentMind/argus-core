import path from 'node:path'
import { asarUnpackedPath } from '../asar'
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
  /** Composed connector servers, translated by `toCopilotMcpServers` — each entry MUST
   *  carry a `tools` allowlist or the runtime loads it `not_configured` (EVIDENCE §6c). */
  mcpServers?: Record<string, unknown>
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

/** Platform packages the Copilot CLI ships as, in the SDK's own preference order. */
function cliPlatformPackages(): string[] {
  return process.platform === 'linux'
    ? [`@github/copilot-linux-${process.arch}`, `@github/copilot-linuxmusl-${process.arch}`]
    : [`@github/copilot-${process.platform}-${process.arch}`]
}

/**
 * Resolve the Copilot CLI's **native** executable (the platform package's `exports["."]`,
 * e.g. `copilot.exe`), rather than letting the SDK fall back to its own `getBundledCliPath()`.
 *
 * Why this exists (verified empirically 2026-07-18, not inferred from types): the SDK's
 * bundled-path resolver always returns the platform package's `index.js`, and for a `.js`
 * entrypoint it spawns `process.execPath`. In the Electron **main** process `process.execPath`
 * is `electron.exe`, which — absent `ELECTRON_RUN_AS_NODE=1` — treats the script as an app
 * path, boots, and exits immediately with code 0. The SDK then surfaces the opaque
 * "CLI server exited unexpectedly with code 0", which is what users saw for every Copilot
 * probe *and* every Copilot session. Pointing at the native binary sidesteps the Node
 * launcher entirely; `ELECTRON_RUN_AS_NODE=1` would also "work" but would run the CLI's
 * native addons under Electron's ABI, which they are not built for.
 *
 * In a packaged build the resolved path lives inside `app.asar`, which Electron virtualizes
 * for `fs` but NOT for `CreateProcess`/`exec` — spawning it fails ENOENT (verified 2026-07-19
 * against `dist/win-unpacked`), the SDK's child never comes up, and its jsonrpc writer floods
 * unhandled `ERR_STREAM_DESTROYED` rejections on every probe. electron-builder already unpacks
 * the native binary, so we rewrite onto the `app.asar.unpacked` twin.
 *
 * Returns null when no platform package is installed — the caller then leaves the SDK to
 * its own resolution so its actionable "Ensure @github/copilot is installed" error wins.
 */
export function resolveCopilotCliPath(
  resolve: (id: string) => string = require.resolve
): string | null {
  for (const name of cliPlatformPackages()) {
    try {
      return asarUnpackedPath(resolve(name))
    } catch {
      // try the next platform package
    }
  }
  return null
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
  // A user-configured cliPath wins; otherwise steer the SDK at the native binary (see
  // `resolveCopilotCliPath`). `env` REPLACES the child env in the SDK (`options.env ??
  // process.env`) rather than merging, so it must be spread from process.env — otherwise
  // the runtime loses PATH/HOME and gh-cli auth resolution silently breaks.
  const cliPath = opts.cliPath ?? resolveCopilotCliPath()
  return new mod.CopilotClient({
    baseDirectory: opts.baseDirectory,
    workingDirectory: opts.workingDirectory,
    logLevel: 'error',
    ...(cliPath ? { env: { ...process.env, COPILOT_CLI_PATH: cliPath } } : {})
  })
}
