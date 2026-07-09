import { useCallback, useEffect, useState } from 'react'
import { CaseDashboard } from './components/CaseDashboard'
import { CaseWorkspace } from './components/CaseWorkspace'
import { SearchBar } from './components/SearchBar'
import { TextViewer } from './components/TextViewer'
import type { CaseRecord, NewCaseInput, SearchHit } from '../../shared/types'

type View = { kind: 'home' } | { kind: 'case'; slug: string }

function App(): React.JSX.Element {
  const [cases, setCases] = useState<CaseRecord[]>([])
  const [view, setView] = useState<View>({ kind: 'home' })
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
    setView({ kind: 'case', slug: input.slug })
  }

  function handleOpenHit(hit: SearchHit): void {
    setViewer({ evidenceId: hit.evidenceId, focusLine: hit.matchLine })
  }

  return (
    <div className="h-screen overflow-auto bg-void text-ink">
      {view.kind === 'home' ? (
        <>
          <CaseDashboard
            cases={cases}
            onOpen={(slug) => setView({ kind: 'case', slug })}
            onCreate={(i) => void handleCreate(i)}
          />
          <div className="mx-auto max-w-5xl px-8 pb-8">
            <SearchBar caseSlug={null} onOpen={handleOpenHit} />
          </div>
        </>
      ) : (
        <CaseWorkspace
          slug={view.slug}
          onBack={() => {
            setView({ kind: 'home' })
            void reload()
          }}
          onOpenHit={handleOpenHit}
          onOpenCitation={(id, line) => setViewer({ evidenceId: id, focusLine: line })}
        />
      )}
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
