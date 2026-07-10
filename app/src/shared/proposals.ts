export const PROPOSAL_TYPES = ['skill-new', 'skill-edit', 'reference-edit', 'recipe'] as const
export type ProposalType = (typeof PROPOSAL_TYPES)[number]
export interface ProposalRecord {
  file: string // file name inside proposals/
  type: ProposalType
  target: string // skill name, or reference file name (recipes name their target reference)
  caseSlug: string
  date: string
  title: string
  content: string // full proposed content (not a diff — the UI renders the diff)
  current: string | null // current content of the target; null when the target is new
}
export interface ProposalsPayload {
  proposals: ProposalRecord[]
}
