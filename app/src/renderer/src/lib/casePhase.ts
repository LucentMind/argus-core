import type { CasePhase } from '../../../shared/types'

/** Every phase in workflow order. The card looks up by key; the dashboard's filter menu and
 *  its count eyebrow iterate this so they can never fall out of step on ordering. */
export const PHASE_ORDER: readonly CasePhase[] = [
  'open',
  'analyzing',
  'pr-created',
  'reviewing',
  'rca-drafted',
  'closed'
]

/** Display form for each phase slug. Every surface that shows a phase to a human renders
 *  through this one map — two vocabularies is how you end up with an eyebrow reading
 *  "1 rca-drafted" directly above a menu saying "RCA drafted". */
export const PHASE_WORD: Record<CasePhase, string> = {
  open: 'Open',
  analyzing: 'Analyzing',
  'pr-created': 'PR created',
  reviewing: 'Reviewing',
  'rca-drafted': 'RCA drafted',
  closed: 'Closed'
}

/** Phase colour as a text-* class: StatusDot fills from currentColor and the word beside it
 *  takes the same class, so dot and label can never disagree.
 *
 *  Six phases share five hues on purpose. `danger` is reserved for "something is broken" and
 *  `mute` for "inactive", so `reviewing` and `rca-drafted` share `analytics` — both mean the
 *  case has reached its output stage, and the word tells them apart. */
export const PHASE_COLOR: Record<CasePhase, string> = {
  open: 'text-signal',
  analyzing: 'text-defect',
  'pr-created': 'text-review',
  reviewing: 'text-analytics',
  'rca-drafted': 'text-analytics',
  closed: 'text-mute'
}
