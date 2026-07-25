import type { ModeRole } from '../../../shared/modes'
import type { ResolvedSkill } from './skillsResolver'

/** Per-description cap: this index is appended to EVERY turn's system prompt, and real
 *  descriptions run ~280 chars — left uncapped, it grows unbounded with the skill catalog. */
const DESCRIPTION_MAX = 200

function truncateDescription(description: string): string {
  return description.length > DESCRIPTION_MAX
    ? `${description.slice(0, DESCRIPTION_MAX)}…`
    : description
}

/**
 * The prompt-visible index of skills relevant to the active mode.
 *
 * This is the ONLY mode-scoped view of skills. The driver allowlist
 * (`assembleMode().enabledSkills`) still carries every enabled skill, so a skill omitted
 * here remains loadable — advertising is scoped, availability is not.
 *
 * WHY THIS IS NOT REDUNDANT WITH THE CLAUDE SDK'S OWN SKILLS CHANNEL
 * Measured 2026-07-25 against @anthropic-ai/claude-agent-sdk 0.3.205 by pointing
 * ANTHROPIC_BASE_URL at a local proxy and reading the CLI's outbound /v1/messages request:
 *
 *   - `options.skills` (drivers/claude/index.ts) is a FILTER, not a preload. No SKILL.md
 *     body reaches the wire. The SDK injects a `system`-role message reading
 *       "The following skills are available for use with the Skill tool:
 *        - argus:<name>: <full, untruncated description>"
 *     listing exactly the allowlisted skills — an allowlist of one listed one. `skills: []`
 *     drops the section entirely; omitting the option lists every discoverable skill,
 *     unqualified. (The "PRELOAD, not a filter" note in drivers/claude/index.ts is about
 *     `AgentDefinition.skills`, the SUBAGENT field — it does not describe this option.)
 *   - So on Claude every name+description pair below is ALREADY in the model's context, and
 *     this index restates it (truncated, unqualified) on every turn.
 *
 * What it adds that the SDK channel structurally cannot: the allowlist is deliberately not
 * mode-filtered, so the SDK's list is byte-identical in every mode. This index is the only
 * thing that tells the model which of those skills fit the mode it is working in. That
 * relevance signal is the entire justification; the duplicated descriptions are its cost.
 *
 * Copilot duplicates the same way (it loads the identical junction dir via
 * `skillDirectories`). Codex and the ACP drivers never receive `ctx.skills` and advertise
 * nothing on their own, so for them this index is the only signal that the skills exist.
 */
export function buildSkillIndex(skills: ResolvedSkill[], role: ModeRole): string {
  // A plain filter, not rankSkillsForMode(...).filter(...): ranking only reorders
  // applying-vs-not, which this filter already isolates, so calling it first was a
  // redundant double-rank that changed nothing about the result.
  const relevant = skills.filter((s) => s.roles.length === 0 || s.roles.includes(role))
  if (relevant.length === 0) return ''
  const lines = relevant.map((s) =>
    s.description ? `- ${s.name}: ${truncateDescription(s.description)}` : `- ${s.name}`
  )
  return [`Skills most relevant to this mode:`, ...lines].join('\n')
}
