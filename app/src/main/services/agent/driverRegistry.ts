import type { AgentSettings } from '../../../shared/settings'
import type { AgentDriver } from './driver'
import { createClaudeDriver } from './drivers/claude'

/** Constructed drivers, keyed by the open `driver` slug stored on a provider instance
 *  (`ProviderInstance.driver` — an open string so unknown/future driver kinds still
 *  round-trip through settings). Phase 1 has only the Claude driver; Phase 3 adds
 *  `'github-copilot'`. */
export const DRIVERS: Record<string, AgentDriver> = {
  'claude-agent-sdk': createClaudeDriver()
}

const fallbackDriver = DRIVERS['claude-agent-sdk']

/** Driver for a given kind slug; falls back to the Claude driver for anything unknown. */
export function getDriverByKind(kind: string): AgentDriver {
  return DRIVERS[kind] ?? fallbackDriver
}

/**
 * Resolves the driver for the active provider instance, the same way AgentService's own
 * default resolves today (`deps.driver ?? createClaudeDriver(...)`): a missing or
 * disabled active instance, or an instance naming an unregistered driver kind, all fall
 * back to the Claude driver. Phase 1 has exactly one driver, so this fallback keeps
 * behavior identical to before drivers existed.
 */
export function getActiveDriver(agent: AgentSettings): AgentDriver {
  const inst = agent.providerInstances[agent.activeInstanceId]
  if (!inst || !inst.enabled) return fallbackDriver
  return getDriverByKind(inst.driver)
}
