export const PROPOSAL_TYPES = [
  'skill-new',
  'skill-edit',
  'reference-edit',
  'recipe',
  'memory-append',
  'case-summary'
] as const
export type ProposalType = (typeof PROPOSAL_TYPES)[number]

export const PROPOSAL_TYPE_LABELS: Record<ProposalType, string> = {
  'skill-new': 'Skill · new',
  'skill-edit': 'Skill · edit',
  'reference-edit': 'Reference',
  recipe: 'Recipe',
  'memory-append': 'Lesson',
  'case-summary': 'Case summary'
}

export interface ProposalRecord {
  file: string // file name inside proposals/
  type: ProposalType
  target: string // skill name, or reference file name (recipes name their target reference)
  caseSlug: string
  date: string
  title: string
  content: string // full proposed content (not a diff — the UI renders the diff)
  current: string | null // current content of the target; null when the target is new
  /** distiller re-produced an item the user already accepted/rejected for this case */
  previouslyReviewed?: boolean
  /** distill job id that produced this proposal; absent for user-authored proposals */
  jobId?: string
}
export interface ProposalsPayload {
  proposals: ProposalRecord[]
}
