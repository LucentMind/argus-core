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
 *  resolved: they are pack-owned text read off disk, not registry entries.
 *
 *  `personaFragmentIds` is parallel to `personaFragments`, carrying the registry id that
 *  produced each one (null for pack text). The session capture attributes bytes with it. */
export function assembleMode(opts: {
  mode: ModeId
  resolvedSkills: ResolvedSkill[]
  packFragments: string[]
  contributeBack: boolean
  resolve?: (id: string) => string
}): {
  personaFragments: string[]
  personaFragmentIds: (string | null)[]
  enabledSkills: string[]
  skillIndex: string
} {
  const def = MODES[opts.mode]
  const r = opts.resolve
  const frag = (id: string, fallback: string): { id: string | null; text: string } => ({
    id,
    text: r ? r(id) : fallback
  })
  // One list of (id, text) pairs rather than two lists built separately: the capture depends on
  // them staying aligned, and a single source makes misalignment unrepresentable.
  const parts: { id: string | null; text: string }[] = [
    ...(def.personaFragment ? [frag(`persona.mode.${opts.mode}`, def.personaFragment)] : []),
    frag('persona.neutral', NEUTRAL_PERSONA),
    frag('persona.diagram', DIAGRAM_FRAGMENT),
    ...opts.packFragments.map((text) => ({ id: null, text })),
    ...(opts.contributeBack ? [frag('persona.contribute-back', CONTRIBUTE_BACK_NUDGE)] : [])
  ]
  const enabled = opts.resolvedSkills.filter((s) => s.enabled)
  const ranked = rankSkillsForMode(enabled, def.role)
  const enabledSkills = ranked.map((s) => s.name)
  const skillIndex = buildSkillIndex(enabled, def.role, opts.resolve)
  return {
    personaFragments: parts.map((p) => p.text),
    personaFragmentIds: parts.map((p) => p.id),
    enabledSkills,
    skillIndex
  }
}
