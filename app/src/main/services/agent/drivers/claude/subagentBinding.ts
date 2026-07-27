import type { SubagentDefinition, SubagentToolKind } from '../../reviewSubagents'

/** Capability kinds → Claude tool ids. Kept beside the driver because the vocabulary is the
 *  SDK's, not Argus's. Order is stable so the options bag is diffable in tests. */
const TOOL_IDS: Record<SubagentToolKind, readonly string[]> = {
  read: ['Read'],
  search: ['Grep', 'Glob'],
  execute: ['Bash']
}

export interface ClaudeAgentEntry {
  description: string
  prompt: string
  tools: string[]
}

/**
 * The SDK `agents` option, or undefined when there is nothing to register — an empty object
 * is NOT the same as omitting the key, and only omission leaves the SDK's own behavior alone.
 *
 * The tool list is an allowlist, which is what keeps `mcp__argus__append_finding` out of a
 * layer agent: candidates return as text and the main agent records the survivors. It also
 * narrows what a subagent can do with a skill it loaded from a linked repo — a side effect,
 * not containment. The skill-leak gap documented at index.ts:105-120 remains open by design.
 */
export function claudeAgentsOption(
  defs: readonly SubagentDefinition[]
): Record<string, ClaudeAgentEntry> | undefined {
  if (defs.length === 0) return undefined
  const out: Record<string, ClaudeAgentEntry> = {}
  for (const def of defs) {
    out[def.name] = {
      description: def.description,
      prompt: def.prompt,
      tools: def.tools.flatMap((k) => [...TOOL_IDS[k]])
    }
  }
  return out
}
