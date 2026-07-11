import { useEffect, useState, useSyncExternalStore } from 'react'
import { agentStore, EMPTY_CASE_AGENT_STATE } from '../lib/agentStore'
import { uiStore } from '../lib/uiStore'
import { MessageView } from './MessageView'
import { SectionLabel } from './ui'

export function FindingsPane({
  slug,
  sessionId,
  onCite
}: {
  slug: string
  sessionId: number | null
  onCite: (relPath: string, line: number) => void
}): React.JSX.Element {
  const [md, setMd] = useState('')
  const bump = useSyncExternalStore(
    (cb) => agentStore.subscribe(cb),
    () =>
      (sessionId === null ? EMPTY_CASE_AGENT_STATE : agentStore.get(slug, sessionId)).findingsBump
  )
  useEffect(() => {
    void window.argus.cases.readFindings(slug).then(setMd)
    // sessionId is in deps (not just bump) so switching sessions always
    // refetches — two sessions can coincidentally share a bump count, which
    // would otherwise skip the refetch on switch. findings.md itself is
    // per-case, so this is about staying correct even if bump doesn't change;
    // a background session's bump does NOT refresh a different active
    // session's view (no cross-session bump plumbing here — see Task 8 notes).
  }, [slug, sessionId, bump])
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
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M15 4v16" />
          </svg>
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
