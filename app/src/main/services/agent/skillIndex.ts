import type { ModeRole } from '../../../shared/modes'
import { rankSkillsForMode, type ResolvedSkill } from './skillsResolver'

/**
 * The prompt-visible index of skills relevant to the active mode.
 *
 * This is the ONLY mode-scoped view of skills. The driver allowlist
 * (`assembleMode().enabledSkills`) still carries every enabled skill, so a skill omitted
 * here remains loadable — advertising is scoped, availability is not.
 */
export function buildSkillIndex(skills: ResolvedSkill[], role: ModeRole): string {
  const relevant = rankSkillsForMode(skills, role).filter(
    (s) => s.roles.length === 0 || s.roles.includes(role)
  )
  if (relevant.length === 0) return ''
  const lines = relevant.map((s) => `- ${s.name}: ${s.description}`.trimEnd())
  return [`Skills most relevant to this mode:`, ...lines].join('\n')
}
