import type { SubagentDefinition, SubagentToolKind } from '../../reviewSubagents'

/** Capability kinds → Copilot tool names, captured 2026-07-27 from the CLI's own shipped
 *  agent definitions (`definitions/*.agent.yaml`). Lowercase and distinct from Claude's ids:
 *  a mismatched name silently grants nothing rather than failing loudly. */
const TOOL_NAMES: Record<SubagentToolKind, readonly string[]> = {
  read: ['view'],
  search: ['grep', 'glob'],
  execute: ['bash']
}

export interface CopilotCustomAgent {
  name: string
  displayName: string
  description: string
  prompt: string
  tools: string[]
}

/**
 * `SessionConfig.customAgents`, or undefined when there is nothing to register.
 *
 * An explicit list, never `tools: ['*']` — the wildcard is what Copilot's own built-in agents
 * use, and it would hand a layer agent every write tool including the Argus native ones. Layer
 * agents return candidates as text; only the main agent records findings.
 */
export function copilotCustomAgents(
  defs: readonly SubagentDefinition[]
): CopilotCustomAgent[] | undefined {
  if (defs.length === 0) return undefined
  return defs.map((def) => ({
    name: def.name,
    displayName: def.name,
    description: def.description,
    prompt: def.prompt,
    tools: def.tools.flatMap((k) => [...TOOL_NAMES[k]])
  }))
}
