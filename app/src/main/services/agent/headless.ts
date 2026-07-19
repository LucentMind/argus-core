import { resolveDistillProvider } from '../../../shared/drivers'
import type { AppSettings } from '../../../shared/settings'
import type { AgentDriver } from './driver'
import { getDriverByKind } from './driverRegistry'

export interface HeadlessRunnerDeps {
  /** Read live on every call — a settings change takes effect on the next job, no restart. */
  settings: () => AppSettings
  argusHome: string
  /** Injection seam for tests; defaults to the real driver registry. */
  driverForKind?: (kind: string) => AgentDriver
}

/**
 * The single headless one-shot entry point for distillation consumers (case close,
 * reference sync). Resolves the configured provider, then delegates to that driver.
 * Throws with the resolver's user-facing reason so DistillQueue can persist it.
 */
export function createHeadlessRunner(
  deps: HeadlessRunnerDeps
): (prompt: string) => Promise<string> {
  const forKind = deps.driverForKind ?? getDriverByKind
  return async (prompt: string) => {
    const r = resolveDistillProvider(deps.settings())
    if (!r.ok) throw new Error(r.reason)
    const driver = forKind(r.driverKind)
    if (!driver.runHeadless)
      throw new Error(
        `provider "${r.instanceId}" (${r.driverKind}) cannot run headless distillation`
      )
    return driver.runHeadless(prompt, {
      model: r.model,
      cliPath: r.cliPath,
      argusHome: deps.argusHome
    })
  }
}
