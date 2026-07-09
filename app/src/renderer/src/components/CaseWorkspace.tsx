import { useEffect, useRef, useSyncExternalStore } from 'react'
import { SearchBar } from './SearchBar'
import { EvidenceLibrary } from './EvidenceLibrary'
import { ChatPane } from './ChatPane'
import { HeaderChips } from './HeaderChips'
import { FindingsPane } from './FindingsPane'
import { WorkspacesStrip } from './WorkspacesStrip'
import { agentStore, wireAgentStore } from '../lib/agentStore'
import { uiStore } from '../lib/uiStore'
import type { SearchHit } from '../../../shared/types'

export function CaseWorkspace({
  slug,
  onOpenHit,
  onOpenCitation
}: {
  slug: string
  onOpenHit: (hit: SearchHit) => void
  onOpenCitation: (evidenceId: number, line: number) => void
}): React.JSX.Element {
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    wireAgentStore()
    // restore the persisted transcript after an app restart
    void window.argus.agent.history(slug).then((events) => agentStore.hydrate(slug, events))
  }, [slug])

  async function handleCite(relPath: string, line: number): Promise<void> {
    const list = await window.argus.evidence.list(slug)
    const rec = list.find((e) => e.relPath === relPath)
    if (rec) onOpenCitation(rec.id, line)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-hair bg-deep px-4 py-2">
        <h1 className="font-mono text-sm text-defect">{slug}</h1>
        <div className="ml-auto">
          <HeaderChips slug={slug} />
        </div>
      </header>
      <WorkspacesStrip slug={slug} />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-r border-hair bg-deep p-3">
          <SearchBar caseSlug={slug} onOpen={onOpenHit} />
          <EvidenceLibrary caseSlug={slug} />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <ChatPane slug={slug} onCite={(p, l) => void handleCite(p, l)} />
        </main>
        {ui.findingsCollapsed ? (
          <button
            aria-label="Expand findings"
            title="Expand findings"
            className="flex w-6 shrink-0 items-center justify-center border-l border-hair bg-deep text-mute transition-colors hover:bg-hi hover:text-ink"
            onClick={() => uiStore.setFindingsCollapsed(false)}
          >
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
                uiStore.setFindingsWidth(drag.current.startWidth + (drag.current.startX - e.clientX))
              }}
              onPointerUp={() => {
                drag.current = null
              }}
            />
            <aside
              className="shrink-0 overflow-y-auto border-l border-hair bg-deep p-3"
              style={{ width: ui.findingsWidth }}
            >
              <FindingsPane slug={slug} onCite={(p, l) => void handleCite(p, l)} />
            </aside>
          </>
        )}
      </div>
    </div>
  )
}
