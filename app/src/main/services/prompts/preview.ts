import { MODES, type ModeId } from '../../../shared/modes'
import type { PromptPreview, PromptPreviewFragment } from '../../../shared/promptsIpc'
import { assembleMode } from '../agent/modeAssembly'
import { composePersona } from '../agent/persona'

/**
 * Blocks a live session appends after the persona that this preview cannot honestly build
 * without a case: both depend on per-case state (agent-access filtering, resolved skills).
 * Surfaced to the UI rather than silently dropped.
 */
const OMITTED_BLOCKS = [
  'Agent memory index — filtered per case by agent-access settings',
  'Skill index — depends on the skills resolved for the case',
  'Driver base prompt — ships inside the provider CLI (see the External category)'
]

export interface PromptPreviewOpts {
  mode: ModeId
  resolve: (id: string) => string
  /** Live pack persona fragments; pack-owned text, never registry entries. */
  packFragments?: string[]
  /** Whether the contribute-back skill resolves enabled (drives the conditional nudge). */
  contributeBack?: boolean
  /** `settings.agent.personaAppend`; appended last by composePersona. */
  personaAppend?: string
}

/**
 * Compose the persona exactly as a session would, with fragment boundaries.
 *
 * Deliberately delegates ordering to `assembleMode` + `composePersona` rather than
 * re-implementing it: a second copy of the ordering rules would drift from what sessions
 * actually send, which is precisely the class of bug this feature exists to expose.
 *
 * `resolvedSkills: []` is safe — the preview ignores `enabledSkills`/`skillIndex`, and passing
 * an empty list cannot change the persona fragments assembleMode returns.
 */
export function buildPromptPreview(opts: PromptPreviewOpts): PromptPreview {
  // Called from an IPC handler whose arguments are untyped at runtime, so the ModeId in the
  // signature is a claim, not a guarantee. Without this, an unknown mode reads MODES[mode] as
  // undefined and fails deep inside assembleMode with an unreadable property access.
  if (!(opts.mode in MODES)) throw new Error(`unknown mode: ${String(opts.mode)}`)
  const packFragments = opts.packFragments ?? []
  const { personaFragments } = assembleMode({
    mode: opts.mode,
    resolvedSkills: [],
    packFragments,
    contributeBack: opts.contributeBack ?? false,
    resolve: opts.resolve
  })
  const text = composePersona(personaFragments, opts.personaAppend)

  // Label each fragment by matching it back to the id that produced it. Pack fragments and
  // personaAppend carry a null id because the registry does not own them.
  const packSet = new Set(packFragments.map((p) => p.trim()).filter(Boolean))
  const ids = [
    `persona.mode.${opts.mode}`,
    'persona.neutral',
    'persona.diagram',
    ...(opts.contributeBack ? ['persona.contribute-back'] : [])
  ]
  const byText = new Map<string, string>()
  for (const id of ids) byText.set(opts.resolve(id).trim(), id)

  const fragments: PromptPreviewFragment[] = []
  let cursor = 0
  const parts = [...personaFragments, opts.personaAppend ?? '']
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0)
  for (const part of parts) {
    const start = text.indexOf(part, cursor)
    const end = start + part.length
    const id = byText.get(part) ?? null
    fragments.push({
      id,
      label: id ?? (packSet.has(part) ? 'Pack persona fragment' : 'Persona append (settings)'),
      start,
      end
    })
    cursor = end
  }

  return { mode: opts.mode, text, fragments, omits: OMITTED_BLOCKS }
}
