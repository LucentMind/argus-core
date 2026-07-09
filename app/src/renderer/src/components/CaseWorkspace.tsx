import { useEffect } from 'react'
import { SearchBar } from './SearchBar'
import { EvidenceLibrary } from './EvidenceLibrary'
import { ChatPane } from './ChatPane'
import { HeaderChips } from './HeaderChips'
import { Btn } from './ui'
import { wireAgentStore } from '../lib/agentStore'
import type { SearchHit } from '../../../shared/types'

export function CaseWorkspace({
  slug, onBack, onOpenHit, onOpenCitation
}: {
  slug: string
  onBack: () => void
  onOpenHit: (hit: SearchHit) => void
  onOpenCitation: (evidenceId: number, line: number) => void
}): React.JSX.Element {
  useEffect(() => wireAgentStore(), [])

  async function handleCite(relPath: string, line: number): Promise<void> {
    const list = await window.argus.evidence.list(slug)
    const rec = list.find((e) => e.relPath === relPath)
    if (rec) onOpenCitation(rec.id, line)
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-hair bg-panel px-4 py-2">
        <Btn onClick={onBack}>← Cases</Btn>
        <h1 className="font-mono text-base text-defect">{slug}</h1>
        <div className="ml-auto">
          <HeaderChips slug={slug} />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 flex-col gap-3 overflow-y-auto border-r border-hair p-3">
          <SearchBar caseSlug={slug} onOpen={onOpenHit} />
          <EvidenceLibrary caseSlug={slug} />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <ChatPane slug={slug} onCite={(p, l) => void handleCite(p, l)} />
        </main>
        <aside className="w-96 overflow-y-auto border-l border-hair p-3" data-testid="findings-slot" />
      </div>
    </div>
  )
}
