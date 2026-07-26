import { MODES, type ModeId } from '../../../shared/modes'
import { rankSkillsForMode, type ResolvedSkill } from './skillsResolver'
import { CONTRIBUTE_BACK_NUDGE, DIAGRAM_FRAGMENT, NEUTRAL_PERSONA } from './persona'
import { buildSkillIndex } from './skillIndex'

/** Turn the active mode + resolved skills into the persona fragments and the ordered
 *  enabled-skill allowlist a session is built from. Pure; wired into AgentService.
 *
 *  Fragment order: mode identity -> role-neutral core -> diagram guidance -> pack fragments -> contribute-back
 *  nudge. This is the whole ordered composition — composePersona no longer prepends a
 *  hardcoded base, so every fragment a session needs must come from here.
 *
 *  `resolve` is the prompt-registry seam (`services/prompts/store.ts`). It is OPTIONAL and
 *  absent means "use the imported constant", i.e. exactly the pre-registry behavior — which is
 *  why every existing caller and test keeps working untouched. Pack fragments are never
 *  resolved: they are pack-owned text read off disk, not registry entries. */
export function assembleMode(opts: {
  mode: ModeId
  resolvedSkills: ResolvedSkill[]
  packFragments: string[]
  contributeBack: boolean
  resolve?: (id: string) => string
}): { personaFragments: string[]; enabledSkills: string[]; skillIndex: string } {
  const def = MODES[opts.mode]
  const r = opts.resolve
  const frag = (id: string, fallback: string): string => (r ? r(id) : fallback)
  const personaFragments = [
    ...(def.personaFragment ? [frag(`persona.mode.${opts.mode}`, def.personaFragment)] : []),
    frag('persona.neutral', NEUTRAL_PERSONA),
    frag('persona.diagram', DIAGRAM_FRAGMENT),
    ...opts.packFragments,
    ...(opts.contributeBack ? [frag('persona.contribute-back', CONTRIBUTE_BACK_NUDGE)] : [])
  ]
  const enabled = opts.resolvedSkills.filter((s) => s.enabled)
  const ranked = rankSkillsForMode(enabled, def.role)
  const enabledSkills = ranked.map((s) => s.name)
  const skillIndex = buildSkillIndex(enabled, def.role, opts.resolve)
  return { personaFragments, enabledSkills, skillIndex }
}
