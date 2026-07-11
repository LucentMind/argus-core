import { useEffect, useState, useSyncExternalStore } from 'react'
import { PanelRight } from 'lucide-react'
import { agentStore } from '../lib/agentStore'
import { uiStore } from '../lib/uiStore'
import { MessageView } from './MessageView'
import { SectionLabel } from './ui'

export function FindingsPane({
  slug,
  onCite
}: {
  slug: string
  onCite: (relPath: string, line: number) => void
}): React.JSX.Element {
  const [md, setMd] = useState('')
  const bump = useSyncExternalStore(
    (cb) => agentStore.subscribe(cb),
    () => agentStore.get(slug).findingsBump
  )
  useEffect(() => {
    void window.argus.cases.readFindings(slug).then(setMd)
  }, [slug, bump])
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <SectionLabel>Findings</SectionLabel>
        <button
          aria-label="Collapse findings"
          title="Collapse findings"
          className="rounded-r1 px-1.5 py-0.5 text-mute transition-colors hover:bg-hair hover:text-ink"
          onClick={() => uiStore.setFindingsCollapsed(true)}
        >
          <PanelRight size={14} strokeWidth={1.5} />
        </button>
      </div>
      {md.trim() ? (
        <MessageView markdown={md} onCite={onCite} />
      ) : (
        <p className="text-xs text-mute">No findings yet.</p>
      )}
    </div>
  )
}
