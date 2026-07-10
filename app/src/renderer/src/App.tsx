import { useCallback, useEffect, useState } from 'react'
import { CaseDashboard } from './components/CaseDashboard'
import { CaseWorkspace } from './components/CaseWorkspace'
import { FileViewer } from './components/FileViewer'
import { NewCaseDialog } from './components/NewCaseDialog'
import { SearchBar } from './components/SearchBar'
import { SettingsView } from './components/settings/SettingsView'
import { TextViewer } from './components/TextViewer'
import { TopBar } from './components/TopBar'
import { uiStore } from './lib/uiStore'
import type { CaseRecord, NewCaseInput, SearchHit } from '../../shared/types'

type View = { kind: 'home' } | { kind: 'case'; slug: string } | { kind: 'settings' }

type Viewer =
  | { kind: 'evidence'; evidenceId: number; focusLine: number }
  | { kind: 'file'; slug: string; relPath: string }
  | null

function App(): React.JSX.Element {
  const [cases, setCases] = useState<CaseRecord[]>([])
  const [view, setView] = useState<View>({ kind: 'home' })
  const [prevView, setPrevView] = useState<View>({ kind: 'home' })
  const [viewer, setViewer] = useState<Viewer>(null)
  const [newCaseOpen, setNewCaseOpen] = useState(false)

  // setState happens in the promise callback (external-system subscription
  // shape), not synchronously in effects — keeps react-hooks/set-state-in-effect happy
  const reload = useCallback((): Promise<void> => window.argus.cases.list().then(setCases), [])

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
    setViewer({ kind: 'evidence', evidenceId: hit.evidenceId, focusLine: hit.matchLine })
  }

  function goHome(): void {
    setView({ kind: 'home' })
    void reload()
  }

  function openSettings(): void {
    if (view.kind !== 'settings') {
      setPrevView(view)
      setView({ kind: 'settings' })
    }
  }
  function closeSettings(): void {
    setView(prevView)
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-void text-ink">
      <TopBar
        activeSlug={view.kind === 'case' ? view.slug : null}
        onHome={goHome}
        onSelect={openCase}
        onSettings={openSettings}
        onNewCase={() => setNewCaseOpen(true)}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {view.kind === 'home' ? (
          <>
            <CaseDashboard cases={cases} onOpen={openCase} onNew={() => setNewCaseOpen(true)} />
            <div className="mx-auto w-full max-w-[1400px] px-8 pb-8">
              <SearchBar caseSlug={null} onOpen={handleOpenHit} />
            </div>
          </>
        ) : view.kind === 'settings' ? (
          <SettingsView onClose={closeSettings} />
        ) : (
          <CaseWorkspace
            slug={view.slug}
            jiraKey={cases.find((c) => c.slug === view.slug)?.jiraKey ?? null}
            jiraSyncedAt={cases.find((c) => c.slug === view.slug)?.jiraSyncedAt ?? null}
            onOpenHit={handleOpenHit}
            onOpenCitation={(id, line) =>
              setViewer({ kind: 'evidence', evidenceId: id, focusLine: line })
            }
            onOpenFile={(node) =>
              setViewer({ kind: 'file', slug: view.slug, relPath: node.relPath })
            }
          />
        )}
      </div>
      {viewer?.kind === 'evidence' && (
        <TextViewer
          evidenceId={viewer.evidenceId}
          focusLine={viewer.focusLine}
          onClose={() => setViewer(null)}
        />
      )}
      {viewer?.kind === 'file' && (
        <FileViewer slug={viewer.slug} relPath={viewer.relPath} onClose={() => setViewer(null)} />
      )}
      {newCaseOpen && (
        <NewCaseDialog
          onClose={() => setNewCaseOpen(false)}
          onCreateBlank={handleCreate}
          onOpenCase={(slug) => {
            void reload()
            openCase(slug)
          }}
        />
      )}
    </div>
  )
}

export default App
