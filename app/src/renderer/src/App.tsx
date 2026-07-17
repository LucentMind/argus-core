import { useCallback, useEffect, useState } from 'react'
import { CaseDashboard } from './components/CaseDashboard'
import { CaseWorkspace } from './components/CaseWorkspace'
import { ImportCaseDialog, type ImportDialogState } from './components/ImportCaseDialog'
import { FileViewer } from './components/FileViewer'
import { NewCaseDialog } from './components/NewCaseDialog'
import { OnboardingProvider } from './components/onboarding/OnboardingProvider'
import { ObservabilityView } from './components/observability/ObservabilityView'
import { SearchBar } from './components/SearchBar'
import { SettingsView, type PageId } from './components/settings/SettingsView'
import { TextViewer } from './components/TextViewer'
import { TopBar } from './components/TopBar'
import { citationsTray } from './lib/citationsTray'
import { composerDraft } from './lib/composerDraft'
import { panelsStore } from './lib/panelsStore'
import { uiStore } from './lib/uiStore'
import type { CaseRecord, NewCaseInput, UnifiedHit } from '../../shared/types'

type View =
  | { kind: 'home' }
  | { kind: 'case'; slug: string }
  | { kind: 'settings'; page?: PageId }
  | { kind: 'observability' }

type Viewer =
  | { kind: 'evidence'; evidenceId: number; focusStart: number; focusEnd: number }
  | { kind: 'file'; slug: string; relPath: string }
  | null

function App(): React.JSX.Element {
  const [cases, setCases] = useState<CaseRecord[]>([])
  const [view, setView] = useState<View>({ kind: 'home' })
  const [prevView, setPrevView] = useState<View>({ kind: 'home' })
  const [viewer, setViewer] = useState<Viewer>(null)
  const [newCaseOpen, setNewCaseOpen] = useState(false)
  const [importDialog, setImportDialog] = useState<ImportDialogState | null>(null)

  // setState happens in the promise callback (external-system subscription
  // shape), not synchronously in effects — keeps react-hooks/set-state-in-effect happy
  const reload = useCallback((): Promise<void> => window.argus.cases.list().then(setCases), [])

  useEffect(() => {
    void reload()
  }, [reload])

  // single global subscriber: cite chips land in the tray regardless of which
  // pane/session is focused when the `cite` verb fires
  useEffect(() => {
    if (!window.argus?.panels?.onCite) return
    return window.argus.panels.onCite(({ caseSlug, sessionId, relPath, line }) =>
      citationsTray.add(caseSlug, sessionId, { relPath, line })
    )
  }, [])

  // single global subscriber: a panel's sendToAgent stages composer text for its
  // bound session, regardless of which pane/session is focused when it fires
  useEffect(() => {
    if (!window.argus?.panels?.onDraft) return
    return window.argus.panels.onDraft(({ caseSlug, sessionId, text }) =>
      composerDraft.set(caseSlug, sessionId, text)
    )
  }, [])

  const openCase = useCallback((slug: string) => {
    uiStore.openTab(slug)
    setView({ kind: 'case', slug })
  }, [])

  async function handleCreate(input: NewCaseInput): Promise<void> {
    await window.argus.cases.create(input)
    await reload()
    openCase(input.slug)
  }

  function handleOpenHit(hit: UnifiedHit): void {
    if (hit.kind === 'chat') {
      // select the session before mounting the workspace — CaseWorkspace reads
      // uiStore.activeSessions[slug] when its session list resolves
      uiStore.setActiveSession(hit.caseSlug, hit.sessionId)
      openCase(hit.caseSlug)
    } else if (hit.kind === 'summary') {
      // closed-case summary hits have no session context — just navigate to the case
      openCase(hit.caseSlug)
    } else {
      setViewer({
        kind: 'evidence',
        evidenceId: hit.evidenceId,
        focusStart: hit.matchLine,
        focusEnd: hit.matchLine
      })
    }
  }

  async function pickBundle(): Promise<void> {
    const r = await window.argus.bundle.inspect()
    if (!r) return // open dialog canceled
    setImportDialog(r.ok ? { inspection: r.inspection } : { error: r.error })
  }

  function goHome(): void {
    setView({ kind: 'home' })
    void reload()
  }

  function openSettings(page?: PageId): void {
    if (view.kind !== 'settings') setPrevView(view)
    setView({ kind: 'settings', page })
  }
  function closeSettings(): void {
    setView(prevView)
  }

  function openObservability(): void {
    if (view.kind !== 'observability') {
      setPrevView(view)
      setView({ kind: 'observability' })
    }
  }

  // A native panel view paints above the DOM, so hide docked panels whenever a
  // modal/dialog is up or the front view is not the active case.
  const occluded = viewer !== null || newCaseOpen || importDialog !== null || view.kind !== 'case'
  useEffect(() => {
    panelsStore.setOccluded(occluded)
  }, [occluded])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-void text-ink">
      <TopBar
        activeSlug={view.kind === 'case' ? view.slug : null}
        onHome={goHome}
        onSelect={openCase}
        onSettings={() => openSettings()}
        onObservability={openObservability}
        onNewCase={() => setNewCaseOpen(true)}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {view.kind === 'home' ? (
          <>
            <CaseDashboard
              cases={cases}
              onOpen={openCase}
              onNew={() => setNewCaseOpen(true)}
              onImport={() => void pickBundle()}
              onDeleted={() => void reload()}
            />
            <div className="mx-auto w-full max-w-[1400px] px-8 pb-8">
              <SearchBar caseSlug={null} onOpen={handleOpenHit} />
            </div>
          </>
        ) : view.kind === 'settings' ? (
          <SettingsView onClose={closeSettings} initialPage={view.page} />
        ) : view.kind === 'observability' ? (
          <ObservabilityView onOpenCase={openCase} />
        ) : (
          <CaseWorkspace
            slug={view.slug}
            jiraKey={cases.find((c) => c.slug === view.slug)?.jiraKey ?? null}
            jiraSyncedAt={cases.find((c) => c.slug === view.slug)?.jiraSyncedAt ?? null}
            status={cases.find((c) => c.slug === view.slug)?.status ?? 'open'}
            resolution={cases.find((c) => c.slug === view.slug)?.resolution ?? null}
            onStatusChanged={() => void reload()}
            onOpenHit={handleOpenHit}
            onOpenCitation={(id, start, end) =>
              setViewer({ kind: 'evidence', evidenceId: id, focusStart: start, focusEnd: end })
            }
            onOpenFile={(node) =>
              setViewer({ kind: 'file', slug: view.slug, relPath: node.relPath })
            }
            onOpenCase={openCase}
          />
        )}
      </div>
      {viewer?.kind === 'evidence' && (
        <TextViewer
          evidenceId={viewer.evidenceId}
          focusStart={viewer.focusStart}
          focusEnd={viewer.focusEnd}
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
      {importDialog && (
        <ImportCaseDialog
          state={importDialog}
          onClose={() => setImportDialog(null)}
          onImported={(slug) => {
            setImportDialog(null)
            void reload()
            openCase(slug)
          }}
        />
      )}
      <OnboardingProvider
        onNavigate={(view, target) => {
          if (view === 'settings') openSettings(target as PageId | undefined)
          else if (target) openCase(target)
        }}
      />
    </div>
  )
}

export default App
