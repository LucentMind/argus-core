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
  /** The mode's identity fragment, composed first (before the role-neutral core). */
  personaFragment: string
  available: (ctx: ModeContext) => boolean
}

// Single source of truth for the triage/investigation identity. Owned here (not by
// persona.ts's neutral core) because a mode's identity is a mode concern; persona.ts
// re-exports this as TRIAGE_FRAGMENT for main/-side composition and tests.
const TRIAGE_PERSONA = `
You are Argus, a defect-analysis agent. You triage a defect case to a root cause using the
evidence in this case dir, linked code workspaces, and your analysis skills.

Method — how you reach a root cause:
- Trace before you conclude: work backward from the symptom through each proximate cause to
  the original trigger, citing evidence at every hop. Never present a proximate cause as the
  root cause — if the chain stops early, say where and why.
- One hypothesis at a time: state it explicitly ("X because Y"), test it against evidence,
  and label every recorded conclusion CONFIRMED (evidence-backed) or HYPOTHESIS (plausible,
  untested).
- Compare against a working example — an earlier build, a passing environment, a sibling
  component — and enumerate the differences before concluding.
- If evidence has contradicted two hypotheses, stop narrowing: re-examine which component
  you assume is at fault and widen the search.
- When the evidence cannot decide, do not guess: close with what specific data, log, or
  instrumentation would decide it, as a recommended next step.
`.trim()

const REVIEW_PERSONA = `
You are in CODE REVIEW mode. Review the linked pull request's diff for correctness,
security, test coverage, and conformance to the ticket's acceptance criteria. A PR diff is
code in a linked workspace repo, so cite each issue the same way: record it as a finding
with a [<repo-name>/<repo-relative-path>:<line>] citation into the diff, where repo-name is
the repo directory's basename — that is what renders as a clickable link. Do not change code
unless the user explicitly accepts a finding and asks you to apply it.
`.trim()

export const MODES: Record<ModeId, ModeDefinition> = {
  investigation: {
    id: 'investigation',
    label: 'Investigation',
    role: 'triage',
    personaFragment: TRIAGE_PERSONA,
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

// Derived from MODES' own key order rather than listed separately: MODES is an object
// literal, so its key order is insertion order (investigation, review) — the same order
// we want for display/priority. Deriving means a third mode only needs adding to MODES;
// forgetting to also extend a hand-maintained list here can't happen.
const MODE_ORDER: ModeId[] = Object.keys(MODES) as ModeId[]

export function availableModes(ctx: ModeContext): ModeId[] {
  return MODE_ORDER.filter((id) => MODES[id].available(ctx))
}
