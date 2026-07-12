import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { PanelRight } from 'lucide-react'
import { SearchBar } from './SearchBar'
import { CaseFiles } from './CaseFiles'
import { ChatPane } from './ChatPane'
import { HeaderChips } from './HeaderChips'
import { FindingsPane } from './FindingsPane'
import { HeaderRepos } from './HeaderRepos'
import { JiraRefreshButton } from './JiraRefreshButton'
import { MenuButton } from './ui'
import { agentStore, wireAgentStore } from '../lib/agentStore'
import { uiStore } from '../lib/uiStore'
import { CASE_RESOLUTIONS } from '../../../shared/types'
import type {
  CaseResolution,
  CaseStatus,
  ChatJumpTarget,
  FileNode,
  UnifiedHit
} from '../../../shared/types'

export function CaseWorkspace({
  slug,
  jiraKey,
  jiraSyncedAt,
  status,
  resolution,
  onStatusChanged,
  onOpenHit,
  onOpenCitation,
  onOpenFile
}: {
  slug: string
  jiraKey: string | null
  jiraSyncedAt: string | null
  status: CaseStatus
  resolution: CaseResolution | null
  onStatusChanged: () => void
  onOpenHit: (hit: UnifiedHit) => void
  onOpenCitation: (evidenceId: number, line: number) => void
  onOpenFile: (node: FileNode) => void
}): React.JSX.Element {
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)
  const [prefill, setPrefill] = useState('')
  const [exportNote, setExportNote] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [sessionsError, setSessionsError] = useState<string | null>(null)
  const [focusTurn, setFocusTurn] = useState<{
    sessionId: number
    target: ChatJumpTarget
  } | null>(null)

  // case switch: drop the previous case's Analyze suggestion so a re-click of an
  // identical suggestion in the new case isn't a setState no-op, and clear the
  // stale sessionId/error so case A's chat doesn't flash while case B's session
  // list loads — adjust-state-during-render; the composer draft itself resets
  // via key={slug} in ChatPane
  const [lastSlug, setLastSlug] = useState(slug)
  if (slug !== lastSlug) {
    setLastSlug(slug)
    setPrefill('')
    setSessionId(null)
    setSessionsError(null)
  }

  useEffect(() => {
    wireAgentStore()
    // guard against a fast A→B slug switch applying A's late-resolving result
    // after B's effect has already taken over
    let stale = false
    void window.argus.sessions
      .list(slug)
      .then((list) => {
        if (stale) return
        setSessionId(uiStore.get().activeSessions[slug] ?? list[0].id)
      })
      .catch(() => {
        if (stale) return
        setSessionsError('Could not load chat sessions.')
      })
    return () => {
      stale = true
    }
  }, [slug])

  function handleSwitchSession(id: number): void {
    uiStore.setActiveSession(slug, id)
    setSessionId(id)
  }

  // a search hit's jump target: switch to its session via the same path as a
  // normal switcher click, then hand ChatPane the message to scroll to + flash
  function handleJumpToTurn(targetSessionId: number, target: ChatJumpTarget): void {
    if (targetSessionId !== sessionId) handleSwitchSession(targetSessionId)
    setFocusTurn({ sessionId: targetSessionId, target })
  }

  useEffect(() => {
    if (sessionId === null) return
    // restore the persisted transcript after an app restart
    void window.argus.agent
      .history(slug, sessionId)
      .then((events) => agentStore.hydrate(slug, sessionId, events))
  }, [slug, sessionId])

  async function handleCite(relPath: string, line: number): Promise<void> {
    const list = await window.argus.evidence.list(slug)
    const rec = list.find((e) => e.relPath === relPath)
    if (rec) onOpenCitation(rec.id, line)
  }

  async function exportBundle(includeTranscripts: boolean): Promise<void> {
    setExportNote(null)
    const r = await window.argus.bundle.export(slug, includeTranscripts)
    if (!r) return // save dialog canceled
    setExportNote(r.ok ? `exported ${r.fileCount} files` : r.error)
  }

  async function applyStatus(next: CaseStatus, res: CaseResolution | null): Promise<void> {
    await window.argus.cases.setStatus(slug, next, res)
    onStatusChanged()
  }
  const statusItems = [
    ...CASE_RESOLUTIONS.map((r) => ({
      label: r,
      onSelect: () => void applyStatus('closed', r)
    })),
    ...(status === 'closed'
      ? [{ label: 'Reopen', onSelect: () => void applyStatus('open', null) }]
      : [])
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-hair bg-deep px-4 py-2">
        <h1 className="font-mono text-sm text-defect">{slug}</h1>
        <MenuButton
          label={
            status === 'closed' ? (resolution ? `Closed · ${resolution}` : 'Closed') : 'Close as…'
          }
          align="left"
          items={statusItems}
        />
        {/* key: reset refresh state (summary note, last-synced) when switching cases */}
        <JiraRefreshButton key={slug} slug={slug} jiraKey={jiraKey} syncedAt={jiraSyncedAt} />
        <MenuButton
          label="Export"
          aria-label="Export case"
          align="left"
          items={[
            { label: 'Export case…', onSelect: () => void exportBundle(true) },
            { label: 'Export without transcripts…', onSelect: () => void exportBundle(false) }
          ]}
        />
        {exportNote && <span className="max-w-56 truncate text-xs text-mute">{exportNote}</span>}
        <HeaderRepos slug={slug} />
        <div className="ml-auto">
          <HeaderChips slug={slug} sessionId={sessionId} />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-r border-hair bg-deep p-3">
          <SearchBar caseSlug={slug} onOpen={onOpenHit} />
          {/* key: reset per-case state (type filter, collapsed dirs, parsing set) when switching cases */}
          <CaseFiles key={slug} caseSlug={slug} onSuggest={setPrefill} onOpenFile={onOpenFile} />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          {sessionsError && <p className="p-3 text-xs text-danger">{sessionsError}</p>}
          {!sessionsError && sessionId !== null && (
            <ChatPane
              slug={slug}
              sessionId={sessionId}
              onSwitchSession={handleSwitchSession}
              onCite={(p, l) => void handleCite(p, l)}
              onJumpToTurn={handleJumpToTurn}
              focusTarget={focusTurn?.target ?? null}
              onFocusConsumed={() => setFocusTurn(null)}
              prefill={prefill}
            />
          )}
        </main>
        {ui.findingsCollapsed ? (
          <button
            aria-label="Expand findings"
            title="Expand findings"
            className="flex w-6 shrink-0 flex-col items-center justify-center gap-2 border-l border-hair bg-deep text-mute transition-colors hover:bg-hi hover:text-ink"
            onClick={() => uiStore.setFindingsCollapsed(false)}
          >
            <PanelRight size={14} strokeWidth={1.5} />
            <span className="rotate-180 font-mono text-[10.5px] uppercase tracking-[0.1em] [writing-mode:vertical-rl]">
              Findings
            </span>
          </button>
        ) : (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize findings pane"
              className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-signal/40"
              onPointerDown={(e) => {
                drag.current = { startX: e.clientX, startWidth: ui.findingsWidth }
                e.currentTarget.setPointerCapture?.(e.pointerId)
              }}
              onPointerMove={(e) => {
                if (!drag.current) return
                uiStore.setFindingsWidth(
                  drag.current.startWidth + (drag.current.startX - e.clientX)
                )
              }}
              onPointerUp={() => {
                drag.current = null
              }}
            />
            <aside
              className="shrink-0 overflow-y-auto border-l border-hair bg-deep p-3"
              style={{ width: ui.findingsWidth }}
            >
              <FindingsPane
                slug={slug}
                sessionId={sessionId}
                onCite={(p, l) => void handleCite(p, l)}
              />
            </aside>
          </>
        )}
      </div>
    </div>
  )
}
