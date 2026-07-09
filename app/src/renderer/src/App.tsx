import { useCallback, useEffect, useState } from 'react'
import { CaseDashboard } from './components/CaseDashboard'
import { CaseWorkspace } from './components/CaseWorkspace'
import { SearchBar } from './components/SearchBar'
import { TextViewer } from './components/TextViewer'
import { TopBar } from './components/TopBar'
import { uiStore } from './lib/uiStore'
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

  const openCase = useCallback((slug: string) => {
    uiStore.openTab(slug)
    setView({ kind: 'case', slug })
  }, [])

  async function handleCreate(input: NewCaseInput): Promise<void> {
    await window.argus.cases.create(input)
    await reload()
    openCase(input.slug)
  }

  function handleOpenHit(hit: SearchHit): void {
    setViewer({ evidenceId: hit.evidenceId, focusLine: hit.matchLine })
  }

  function goHome(): void {
    setView({ kind: 'home' })
    void reload()
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-void text-ink">
      <TopBar
        activeSlug={view.kind === 'case' ? view.slug : null}
        onHome={goHome}
        onSelect={openCase}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {view.kind === 'home' ? (
          <>
            <CaseDashboard cases={cases} onOpen={openCase} onCreate={(i) => void handleCreate(i)} />
            <div className="mx-auto w-full max-w-5xl px-8 pb-8">
              <SearchBar caseSlug={null} onOpen={handleOpenHit} />
            </div>
          </>
        ) : (
          <CaseWorkspace
            slug={view.slug}
            onOpenHit={handleOpenHit}
            onOpenCitation={(id, line) => setViewer({ evidenceId: id, focusLine: line })}
          />
        )}
      </div>
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
