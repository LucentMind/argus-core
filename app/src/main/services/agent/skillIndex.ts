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
 * NOT EVERY DRIVER GETS THIS — see the gate at the bottom.
 *
 * WHAT THE CLAUDE SDK ALREADY SENDS ON ITS OWN
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
 * Nor does the index carry a mode signal the SDK lacks: `assembleMode` ranks
 * `enabledSkills` with `rankSkillsForMode` before handing them over, and that order is
 * preserved on the wire — so mode-relevant skills already sort to the TOP of the SDK's own
 * list. On Claude this index therefore adds nothing at all, and a pack that wants to steer
 * the model toward its own skills can say so in its `personaText`, which it authors
 * alongside them.
 *
 * WHO ACTUALLY GETS IT
 * `CaseSession` appends this only when the driver's `capabilities.advertisesSkills` is not
 * set:
 *   - Claude sets it (measured above) — pays nothing.
 *   - Codex and the ACP drivers receive no skill channel whatsoever: no `ctx.skills`, no
 *     skill directories, and the case CLAUDE.md never mentions skills. Their session cwd is
 *     the case dir, so they CAN read `<caseDir>/.claude/skills/<name>/SKILL.md` — but only
 *     if something tells them it exists. This index is that something, and their only one.
 *   - Copilot deliberately still receives it. It loads the same junction dir via
 *     `skillDirectories`, but whether that reaches its MODEL as a name+description list has
 *     NOT been measured; asserting it on a guess would silently hide every skill.
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
