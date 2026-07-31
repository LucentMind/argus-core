import type { CaseStatus } from '../../../shared/types'

/** Every status in display order. The card looks up by key; the dashboard's status filter
 *  menu and its count eyebrow iterate this so they can never fall out of step with each
 *  other on ordering. */
export const STATUS_ORDER: readonly CaseStatus[] = ['open', 'analyzing', 'rca-drafted', 'closed']

/** Display form for each DB status slug. The DB values are kebab/lowercase; every surface
 *  that shows a case's status to a human — the card's status word, the dashboard's status
 *  filter menu, and the count eyebrow — must render through this one map. Two vocabularies
 *  (or a countLabel that skips the map and interpolates the raw slug) is how you end up with
 *  the eyebrow reading "1 rca-drafted" directly above a menu saying "RCA drafted". */
export const STATUS_WORD: Record<CaseStatus, string> = {
  open: 'Open',
  analyzing: 'Analyzing',
  'rca-drafted': 'RCA drafted',
  closed: 'Closed'
}
