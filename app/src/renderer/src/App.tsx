import { useCallback, useEffect, useState } from 'react'
import { CaseList } from './components/CaseList'
import { EvidenceLibrary } from './components/EvidenceLibrary'
import { SearchBar } from './components/SearchBar'
import { TextViewer } from './components/TextViewer'
import type { CaseRecord, NewCaseInput, SearchHit } from '../../shared/types'

function App(): React.JSX.Element {
  const [cases, setCases] = useState<CaseRecord[]>([])
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [viewer, setViewer] = useState<{ evidenceId: number; focusLine: number } | null>(null)

  const reload = useCallback(async () => {
    setCases(await window.argus.cases.list())
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  async function handleCreate(input: NewCaseInput): Promise<void> {
    await window.argus.cases.create(input)
    await reload()
    setSelectedSlug(input.slug)
  }

  function handleOpenHit(hit: SearchHit): void {
    setViewer({ evidenceId: hit.evidenceId, focusLine: hit.startLine })
  }

  return (
    <div className="flex h-screen bg-neutral-900 text-neutral-100">
      <CaseList
        cases={cases}
        selectedSlug={selectedSlug}
        onSelect={setSelectedSlug}
        onCreate={(i) => void handleCreate(i)}
      />
      <main className="flex-1 p-4">
        {selectedSlug ? (
          <div className="flex flex-col gap-4">
            <h1 className="text-lg font-semibold">{selectedSlug}</h1>
            <SearchBar caseSlug={selectedSlug} onOpen={handleOpenHit} />
            <EvidenceLibrary caseSlug={selectedSlug} />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-neutral-400">Select or create a case.</p>
            <SearchBar caseSlug={null} onOpen={handleOpenHit} />
          </div>
        )}
      </main>
      {viewer && (
        <TextViewer
          evidenceId={viewer.evidenceId}
          focusLine={viewer.focusLine}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  )
}

export default App
