// placeholder, replaced in Task 16
import { SearchBar } from './SearchBar'
import { EvidenceLibrary } from './EvidenceLibrary'
import { Btn } from './ui'
import type { SearchHit } from '../../../shared/types'

export function CaseWorkspace({
  slug, onBack, onOpenHit
}: {
  slug: string
  onBack: () => void
  onOpenHit: (hit: SearchHit) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <Btn onClick={onBack}>← Cases</Btn>
        <h1 className="font-mono text-lg text-defect">{slug}</h1>
      </div>
      <SearchBar caseSlug={slug} onOpen={onOpenHit} />
      <EvidenceLibrary caseSlug={slug} />
    </div>
  )
}
