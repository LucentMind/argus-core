import { useEffect, useState, useSyncExternalStore } from 'react'
import { ChevronRight, PanelRight, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react'
import { agentStore, EMPTY_CASE_AGENT_STATE } from '../lib/agentStore'
import { uiStore } from '../lib/uiStore'
import type { FindingRow, ReviewState } from '../../../shared/observability'
import { MessageView } from './MessageView'
import { SectionLabel } from './ui'

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

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
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [clearError, setClearError] = useState<string | null>(null)
  const bump = useSyncExternalStore(
    (cb) => agentStore.subscribe(cb),
    () =>
      (sessionId === null ? EMPTY_CASE_AGENT_STATE : agentStore.get(slug, sessionId)).findingsBump
  )
  useEffect(() => {
    // readFindings is kept only to gate the Clear button (stray findings.md
    // content with no rows should still be clearable); per-finding bodies come
    // from findings.list now, not this blob.
    void window.argus.cases.readFindings(slug).then(setMd)
    void window.argus.findings.list(slug).then(setFindings)
  }, [slug, sessionId, bump])

  // Toggle semantics: clicking the active thumb returns the finding to pending.
  async function setReview(id: number, next: 'accepted' | 'rejected'): Promise<void> {
    const cur = findings.find((f) => f.id === id)?.reviewState
    const state: ReviewState = cur === next ? 'pending' : next
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

  // the seeded file is just "# Findings — <slug>" — nothing worth clearing
  const hasBody = md.split('\n').some((l) => l.trim() !== '' && !/^#\s/.test(l.trim()))

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <SectionLabel>
          {findings.length > 0 ? `Findings · ${findings.length}` : 'Findings'}
        </SectionLabel>
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
      {findings.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {findings.map((f) => {
            const open = expandedId === f.id
            const accepted = f.reviewState === 'accepted'
            const rejected = f.reviewState === 'rejected'
            const toggle = (): void => {
              if (f.body) setExpandedId(open ? null : f.id)
            }
            return (
              <li
                key={f.id}
                className={`rounded-r2 border bg-panel ${
                  accepted ? 'border-review/35' : rejected ? 'border-danger/35' : 'border-hair'
                }`}
              >
                <div className="flex items-start gap-1.5 px-2 py-1.5">
                  <ChevronRight
                    size={13}
                    className={`mt-0.5 shrink-0 text-mute transition-transform ${
                      open ? 'rotate-90' : ''
                    } ${f.body ? '' : 'opacity-0'}`}
                  />
                  <button
                    className="flex-1 text-left text-xs leading-snug text-ink disabled:cursor-default"
                    disabled={!f.body}
                    aria-expanded={f.body ? open : undefined}
                    onClick={toggle}
                  >
                    {f.summary}
                  </button>
                </div>
                {open && f.body && (
                  <div className="border-t border-hair px-2 py-1.5 text-xs">
                    <MessageView markdown={f.body} onCite={onCite} />
                  </div>
                )}
                <div className="flex items-center gap-2 px-2 pb-1.5">
                  <span className="font-mono text-[10px] text-mute">
                    {formatWhen(f.createdAt)}
                    {f.sessionId != null ? ` · sess ${f.sessionId}` : ''}
                  </span>
                  <span className="flex-1" />
                  <button
                    aria-label="Mark finding good"
                    aria-pressed={accepted}
                    title="Good finding"
                    className={`inline-flex h-6 w-6 items-center justify-center rounded-r2 border transition-colors ${
                      accepted
                        ? 'border-review bg-review/15 text-review'
                        : 'border-hair2 text-mute hover:text-ink'
                    }`}
                    onClick={() => void setReview(f.id, 'accepted')}
                  >
                    <ThumbsUp size={13} />
                  </button>
                  <button
                    aria-label="Mark finding not useful"
                    aria-pressed={rejected}
                    title="Not useful"
                    className={`inline-flex h-6 w-6 items-center justify-center rounded-r2 border transition-colors ${
                      rejected
                        ? 'border-danger bg-danger/15 text-danger'
                        : 'border-hair2 text-mute hover:text-ink'
                    }`}
                    onClick={() => void setReview(f.id, 'rejected')}
                  >
                    <ThumbsDown size={13} />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-xs text-mute">No findings yet.</p>
      )}
    </div>
  )
}
