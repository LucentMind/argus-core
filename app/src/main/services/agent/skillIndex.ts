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
