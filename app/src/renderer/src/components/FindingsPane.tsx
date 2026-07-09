import { useEffect, useState, useSyncExternalStore } from 'react'
import { agentStore } from '../lib/agentStore'
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
      <SectionLabel>Findings</SectionLabel>
      {md.trim() ? <MessageView markdown={md} onCite={onCite} /> : <p className="text-xs text-mute">No findings yet.</p>}
    </div>
  )
}
