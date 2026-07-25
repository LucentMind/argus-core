import { MODES, type ModeId } from '../../../shared/modes'
import { rankSkillsForMode, type ResolvedSkill } from './skillsResolver'
import { CONTRIBUTE_BACK_NUDGE, NEUTRAL_PERSONA } from './persona'

/** Turn the active mode + resolved skills into the persona fragments and the ordered
 *  enabled-skill allowlist a session is built from. Pure; wired into AgentService.
 *
 *  Fragment order: mode identity -> role-neutral core -> pack fragments -> contribute-back
 *  nudge. This is the whole ordered composition — composePersona no longer prepends a
 *  hardcoded base, so every fragment a session needs must come from here. */
export function assembleMode(opts: {
  mode: ModeId
  resolvedSkills: ResolvedSkill[]
  packFragments: string[]
  contributeBack: boolean
}): { personaFragments: string[]; enabledSkills: string[] } {
  const def = MODES[opts.mode]
  const personaFragments = [
    ...(def.personaFragment ? [def.personaFragment] : []),
    NEUTRAL_PERSONA,
    ...opts.packFragments,
    ...(opts.contributeBack ? [CONTRIBUTE_BACK_NUDGE] : [])
  ]
  const enabled = opts.resolvedSkills.filter((s) => s.enabled)
  const enabledSkills = rankSkillsForMode(enabled, def.role).map((s) => s.name)
  return { personaFragments, enabledSkills }
}
