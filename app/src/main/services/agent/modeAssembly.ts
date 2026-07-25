import { MODES, type ModeId } from '../../../shared/modes'
import { rankSkillsForMode, type ResolvedSkill } from './skillsResolver'
import { CONTRIBUTE_BACK_NUDGE } from './persona'

/** Turn the active mode + resolved skills into the persona fragments and the ordered
 *  enabled-skill allowlist a session is built from. Pure; wired into AgentService. */
export function assembleMode(opts: {
  mode: ModeId
  resolvedSkills: ResolvedSkill[]
  packFragments: string[]
  contributeBack: boolean
}): { personaFragments: string[]; enabledSkills: string[] } {
  const def = MODES[opts.mode]
  const personaFragments = [
    ...opts.packFragments,
    ...(def.personaFragment ? [def.personaFragment] : []),
    ...(opts.contributeBack ? [CONTRIBUTE_BACK_NUDGE] : [])
  ]
  const enabled = opts.resolvedSkills.filter((s) => s.enabled)
  const enabledSkills = rankSkillsForMode(enabled, def.role).map((s) => s.name)
  return { personaFragments, enabledSkills }
}
