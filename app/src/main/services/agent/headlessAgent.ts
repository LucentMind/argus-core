import { resolveDistillAgentProvider } from '../../../shared/drivers'
import type { HeadlessAgentResult } from './driver'
import { getDriverByKind } from './driverRegistry'
import type { HeadlessRunnerDeps } from './headless'

/** Per-call inputs beyond the driver-agnostic `HeadlessRunnerDeps` — the tool surface a
 *  single agentic run needs, threaded straight through to `runHeadlessAgent`. */
export interface HeadlessAgentRunOpts {
  mcpServer: unknown
  allowedTools: string[]
  maxIterations: number
  signal?: AbortSignal
}

/**
 * The agentic headless entry point for distillation v2's world-model builder — same shape
 * as `createHeadlessRunner` (headless.ts), but resolves via `resolveDistillAgentProvider`
 * (the `headlessAgent` capability, not `headlessOneShot`) and threads `mcpServer`/
 * `allowedTools`/`maxIterations` into the driver call. Throws with the resolver's
 * user-facing reason so DistillQueue can persist it.
 */
export function createHeadlessAgentRunner(
  deps: HeadlessRunnerDeps
): (prompt: string, opts: HeadlessAgentRunOpts) => Promise<HeadlessAgentResult> {
  const forKind = deps.driverForKind ?? getDriverByKind
  return async (prompt: string, opts: HeadlessAgentRunOpts) => {
    const r = resolveDistillAgentProvider(deps.settings())
    if (!r.ok) throw new Error(r.reason)
    const driver = forKind(r.driverKind)
    if (!driver.runHeadlessAgent)
      throw new Error(
        `provider "${r.instanceId}" (${r.driverKind}) cannot run agent-based distillation`
      )
    return driver.runHeadlessAgent(prompt, {
      model: r.model,
      cliPath: r.cliPath,
      argusHome: deps.argusHome,
      timeoutMs: deps.timeoutMs,
      mcpServer: opts.mcpServer,
      allowedTools: opts.allowedTools,
      maxIterations: opts.maxIterations,
      ...(opts.signal ? { signal: opts.signal } : {})
    })
  }
}
