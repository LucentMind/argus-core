import { REVIEW_LAYERS, type ReviewLayerId } from '../../../shared/reviewLayers'

/**
 * Capability-level tool names, not any driver's vocabulary. Each driver maps these onto its
 * own tool ids (Task 4/5) — Claude calls its shell tool `Bash`, Copilot calls it `bash`, and a
 * shared list written in either dialect would silently grant nothing on the other.
 */
export type SubagentToolKind = 'read' | 'search' | 'execute'

export interface SubagentDefinition {
  /** Stable registration name; also what the main agent delegates to. */
  name: string
  /** When to delegate here. The main agent reads these to pick applicable layers. */
  description: string
  /** Identity + task, already resolved through the prompt registry. */
  prompt: string
  tools: readonly SubagentToolKind[]
}

/**
 * No findings tool by construction. A layer subagent reads the diff, greps for callers and
 * runs git history — it carries `execute` (a shell), so it is not read-only in the filesystem
 * sense; what it never gets is `append_finding` or any file-write tool. Candidates come back
 * as text and only the main agent records survivors (spec §5 triage). Its shell calls still
 * re-enter Argus's approval pipeline exactly like the main session's — being a subagent grants
 * no bypass.
 */
export const LAYER_AGENT_TOOLS: readonly SubagentToolKind[] = ['read', 'search', 'execute']

/** Compile the selected layers into definitions a driver can register. Pure. `resolve` is the
 *  prompt-registry seam; absent means "use the shipped text", exactly as assembleMode does.
 *  `description` is model-facing (the main agent reads it to pick applicable layers, and it's
 *  rendered into the composed prompt's layer menu) so it goes through `resolve` exactly like
 *  `persona` and `task` below — it used to read `def.appliesWhen` directly and silently bypass
 *  an override. */
export function compileLayerAgents(
  layers: readonly ReviewLayerId[],
  resolve?: (id: string) => string
): SubagentDefinition[] {
  return layers.map((id) => {
    const def = REVIEW_LAYERS[id]
    const persona = resolve ? resolve(`review.layer.${id}.persona`) : def.personaFragment
    const task = resolve ? resolve(`review.layer.${id}.prompt`) : def.prompt
    const description = resolve ? resolve(`review.layer.${id}.applies-when`) : def.appliesWhen
    return {
      name: `review-${id}`,
      description,
      prompt: `${persona}\n\n${task}`,
      tools: LAYER_AGENT_TOOLS
    }
  })
}
