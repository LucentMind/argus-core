import { InstalledSkills } from './InstalledSkills'
import { ProposalsBanner } from './ProposalsBanner'
import type { ProposalType } from '../../../../shared/proposals'

const SKILL_TYPES: readonly ProposalType[] = ['skill-new', 'skill-edit']

export function SkillsSettings({
  onReviewProposals
}: {
  onReviewProposals?: (types: readonly ProposalType[]) => void
} = {}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      {onReviewProposals && (
        <ProposalsBanner
          types={SKILL_TYPES}
          noun="skills"
          onReview={() => onReviewProposals(SKILL_TYPES)}
        />
      )}
      <InstalledSkills />
    </div>
  )
}
