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

export interface ResolvedDriver {
  driver: AgentDriver
  /** Set when the active instance names a driver kind not in `DRIVERS` (e.g.
   *  `'github-copilot'` before Task 9A registers it) — `driver` is still the Claude
   *  fallback, but callers that must not silently boot the wrong driver (probes) can
   *  check this and short-circuit instead. */
  unknownSlug?: string
}

/**
 * Resolves the driver for the active provider instance, distinguishing *why* the
 * fallback applies: a missing/disabled active instance always falls back to Claude
 * silently (same as before drivers existed), but an instance naming an unregistered
 * driver kind also falls back to Claude while flagging `unknownSlug` — with two+ drivers
 * that distinction matters for probes, which must never boot Claude to "check" a Copilot
 * slug that simply isn't registered yet.
 */
export function resolveDriver(agent: AgentSettings): ResolvedDriver {
  const inst = agent.providerInstances[agent.activeInstanceId]
  if (!inst || !inst.enabled) return { driver: fallbackDriver }
  const known = DRIVERS[inst.driver]
  if (known) return { driver: known }
  return { driver: fallbackDriver, unknownSlug: inst.driver }
}

/** Driver for the active provider instance; falls back to Claude for missing/disabled/
 *  unknown-slug instances alike. Use `resolveDriver` directly when the unknown-slug case
 *  must be distinguished (e.g. probes, which must not boot the fallback driver). */
export function getActiveDriver(agent: AgentSettings): AgentDriver {
  return resolveDriver(agent).driver
}
