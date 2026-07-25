export type ModeId = 'investigation' | 'review'
export type ModeRole = 'triage' | 'review'

/** Inputs the availability rules read. Extended by later plans (Plan 2 populates linkedPrCount). */
export interface ModeContext {
  linkedPrCount: number
}

export interface ModeDefinition {
  id: ModeId
  label: string
  role: ModeRole
  /** Appended as a persona fragment when this mode is active. Empty = no change (investigation). */
  personaFragment: string
  available: (ctx: ModeContext) => boolean
}

const REVIEW_PERSONA = `
You are in CODE REVIEW mode. Review the linked pull request's diff for correctness,
security, test coverage, and conformance to the ticket's acceptance criteria. Record each
issue as a finding with a [<path>:<line>] citation into the diff. Do not change code unless
the user explicitly accepts a finding and asks you to apply it.
`.trim()

export const MODES: Record<ModeId, ModeDefinition> = {
  investigation: {
    id: 'investigation',
    label: 'Investigation',
    role: 'triage',
    personaFragment: '',
    available: () => true
  },
  review: {
    id: 'review',
    label: 'Review',
    role: 'review',
    personaFragment: REVIEW_PERSONA,
    available: (ctx) => ctx.linkedPrCount > 0
  }
}

export const DEFAULT_MODE: ModeId = 'investigation'

const MODE_ORDER: ModeId[] = ['investigation', 'review']

export function availableModes(ctx: ModeContext): ModeId[] {
  return MODE_ORDER.filter((id) => MODES[id].available(ctx))
}
