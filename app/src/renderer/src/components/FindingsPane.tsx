import { useEffect, useState, useSyncExternalStore } from 'react'
import { ChevronRight, PanelRight, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react'
import { agentStore, EMPTY_CASE_AGENT_STATE } from '../lib/agentStore'
import { confirm } from '../lib/confirmStore'
import { reposStore } from '../lib/reposStore'
import { uiStore } from '../lib/uiStore'
import type { FindingRow, ReviewState } from '../../../shared/observability'
import { REVIEW_LAYERS, REVIEW_LAYER_ORDER } from '../../../shared/reviewLayers'
import type { ReviewLayerId } from '../../../shared/reviewLayers'
import type { CiteTarget } from '../lib/citations'
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
  onCite: (cite: CiteTarget) => void
}): React.JSX.Element {
  const [md, setMd] = useState('')
  const [findings, setFindings] = useState<FindingRow[]>([])
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [clearError, setClearError] = useState<string | null>(null)
  const [layerFilter, setLayerFilter] = useState<ReviewLayerId | null>(null)
  const bump = useSyncExternalStore(
    (cb) => agentStore.subscribe(cb),
    () =>
      (sessionId === null ? EMPTY_CASE_AGENT_STATE : agentStore.get(slug, sessionId)).findingsBump
  )
  const repoNames = useSyncExternalStore(
    (cb) => reposStore.subscribe(cb),
    () => reposStore.get(slug)
  ).names
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
    const ok = await confirm({
      title: 'Clear all findings for this case?',
      message: `${count} finding${count === 1 ? '' : 's'} and findings.md are reset.`,
      confirmLabel: 'Clear all',
      danger: true
    })
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

  // Most-severe first, matching how the review persona is told to rank. Unflavored
  // (investigation) findings sort after every severity, then newest-first as before — the list
  // query already returns id DESC, so a stable sort preserves that inside each bucket.
  const SEVERITY_RANK: Record<string, number> = { critical: 0, major: 1, minor: 2 }
  const rank = (f: FindingRow): number =>
    f.severity ? SEVERITY_RANK[f.severity] : Object.keys(SEVERITY_RANK).length

  // Chips for layers actually present: a filter for a layer with no findings is a dead control.
  const presentLayers = REVIEW_LAYER_ORDER.filter((id) => findings.some((f) => f.layer === id))
  const layerCounts = new Map(
    presentLayers.map((id) => [id, findings.filter((f) => f.layer === id).length])
  )
  // Derived, not authoritative: layerFilter is only state that *asked* to filter. If the
  // finding set changes underneath it (session/mode switch, clear-all, a new run — this pane
  // instance has no key and survives all of those) and the requested layer is no longer
  // present, the filter self-clears here with no extra effect and no dead-end empty state.
  const effectiveFilter =
    layerFilter !== null && presentLayers.includes(layerFilter) ? layerFilter : null
  const shown = findings
    .filter((f) => effectiveFilter === null || f.layer === effectiveFilter)
    .slice()
    .sort((a, b) => rank(a) - rank(b))

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
      {/* A count suffix (the same "field · value" idiom as the " · sess N" tag below) makes
          the chip read as a control with its own state, not a copy of the finding badge. */}
      {presentLayers.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {presentLayers.map((id) => (
            <button
              key={id}
              type="button"
              aria-label={`Filter · ${REVIEW_LAYERS[id].label}`}
              aria-pressed={effectiveFilter === id}
              onClick={() => setLayerFilter(effectiveFilter === id ? null : id)}
              className={`rounded-r1 border px-1.5 py-0.5 text-[10px] transition-colors ${
                effectiveFilter === id
                  ? 'border-signal bg-signal/15 text-ink'
                  : 'border-hair2 text-mute hover:text-ink'
              }`}
            >
              {REVIEW_LAYERS[id].label} · {layerCounts.get(id)}
            </button>
          ))}
        </div>
      )}
      {shown.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {shown.map((f) => {
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
                    <MessageView
                      markdown={f.body}
                      onCite={onCite}
                      caseSlug={slug}
                      citationMode="expanded"
                      repoNames={repoNames}
                    />
                  </div>
                )}
                <div className="flex items-center gap-2 px-2 pb-1.5">
                  <span className="font-mono text-[10px] text-mute">
                    {formatWhen(f.createdAt)}
                    {f.sessionId != null ? ` · sess ${f.sessionId}` : ''}
                  </span>
                  {f.layer && (
                    <span className="rounded-r1 border border-hair2 px-1 text-[10px] text-mute">
                      {REVIEW_LAYERS[f.layer].label}
                    </span>
                  )}
                  {f.severity && (
                    <span
                      className={`rounded-r1 px-1 text-[10px] ${
                        f.severity === 'critical'
                          ? 'bg-danger/15 text-danger'
                          : f.severity === 'major'
                            ? 'bg-signal/15 text-ink'
                            : 'text-mute'
                      }`}
                    >
                      {f.severity}
                    </span>
                  )}
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
        <p className="text-xs text-mute">
          {findings.length > 0 ? 'No findings match this filter.' : 'No findings yet.'}
        </p>
      )}
    </div>
  )
}
