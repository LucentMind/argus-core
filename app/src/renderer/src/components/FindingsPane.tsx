import { useEffect, useState, useSyncExternalStore } from 'react'
import { Check, PanelRight, Trash2, X } from 'lucide-react'
import { agentStore, EMPTY_CASE_AGENT_STATE } from '../lib/agentStore'
import { uiStore } from '../lib/uiStore'
import type { FindingRow } from '../../../shared/observability'
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
  const [findings, setFindings] = useState<FindingRow[]>([])
  const [clearError, setClearError] = useState<string | null>(null)
  const bump = useSyncExternalStore(
    (cb) => agentStore.subscribe(cb),
    () =>
      (sessionId === null ? EMPTY_CASE_AGENT_STATE : agentStore.get(slug, sessionId)).findingsBump
  )
  useEffect(() => {
    void window.argus.cases.readFindings(slug).then(setMd)
    void window.argus.findings.list(slug).then(setFindings)
    // sessionId is in deps (not just bump) so switching sessions always
    // refetches — two sessions can coincidentally share a bump count, which
    // would otherwise skip the refetch on switch. findings.md itself is
    // per-case, so this is about staying correct even if bump doesn't change;
    // a background session's bump does NOT refresh a different active
    // session's view (no cross-session bump plumbing here — see Task 8 notes).
  }, [slug, sessionId, bump])

  async function reviewFinding(id: number, state: 'accepted' | 'rejected'): Promise<void> {
    await window.argus.findings.review(id, state)
    setFindings((prev) => prev.map((f) => (f.id === id ? { ...f, reviewState: state } : f)))
  }

  async function clearAll(): Promise<void> {
    const count = findings.length
    const ok = window.confirm(
      `Clear all findings for this case? ${count} finding${count === 1 ? '' : 's'} and findings.md are reset.`
    )
    if (!ok) return
    setClearError(null)
    try {
      await window.argus.findings.clear(slug)
    } catch (err) {
      setClearError((err as Error).message)
    } finally {
      await window.argus.findings.list(slug).then(setFindings)
      await window.argus.cases.readFindings(slug).then(setMd)
    }
  }

  // the seeded file is just "# Findings — <slug>" — nothing worth rendering or clearing
  const hasBody = md.split('\n').some((l) => l.trim() !== '' && !/^#\s/.test(l.trim()))

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <SectionLabel>Findings</SectionLabel>
        <div className="flex items-center gap-1">
          {(findings.length > 0 || hasBody) && (
            <button
              aria-label="Clear findings"
              title="Clear all findings"
              className="rounded-r1 px-1.5 py-0.5 text-mute transition-colors hover:bg-hair hover:text-danger"
              onClick={() => void clearAll()}
            >
              <Trash2 size={14} strokeWidth={1.5} />
            </button>
          )}
          <button
            aria-label="Collapse findings"
            title="Collapse findings"
            className="rounded-r1 px-1.5 py-0.5 text-mute transition-colors hover:bg-hair hover:text-ink"
            onClick={() => uiStore.setFindingsCollapsed(true)}
          >
            <PanelRight size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>
      {clearError && <p className="text-xs text-danger">{clearError}</p>}
      {findings.length > 0 && (
        <ul className="flex flex-col gap-1">
          {findings.map((f) => (
            <li
              key={f.id}
              className="flex items-center gap-2 rounded-r1 border border-hair bg-deep px-2 py-1 text-xs"
            >
              <span className="flex-1 truncate text-ink">{f.summary}</span>
              <span className="text-mute">{f.reviewState}</span>
              <button
                aria-label="Accept finding"
                className="text-mute hover:text-signal"
                onClick={() => void reviewFinding(f.id, 'accepted')}
              >
                <Check size={13} />
              </button>
              <button
                aria-label="Reject finding"
                className="text-mute hover:text-danger"
                onClick={() => void reviewFinding(f.id, 'rejected')}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {hasBody ? (
        <MessageView markdown={md} onCite={onCite} />
      ) : (
        <p className="text-xs text-mute">No findings yet.</p>
      )}
    </div>
  )
}
