import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  ChevronRight,
  GitCommitVertical,
  MessageSquarePlus,
  PanelRight,
  ThumbsDown,
  ThumbsUp,
  Trash2
} from 'lucide-react'
import { agentStore, EMPTY_CASE_AGENT_STATE } from '../lib/agentStore'
import { confirm } from '../lib/confirmStore'
import { reposStore } from '../lib/reposStore'
import { uiStore } from '../lib/uiStore'
import type { FindingRow, ReviewState } from '../../../shared/observability'
import { REVIEW_LAYERS, REVIEW_LAYER_ORDER } from '../../../shared/reviewLayers'
import type { ReviewLayerId } from '../../../shared/reviewLayers'
import type { ModeId } from '../../../shared/modes'
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
  activeMode,
  onCite
}: {
  slug: string
  sessionId: number | null
  /** Findings are case-scoped in the DB but mode-scoped on screen: investigation findings do
   *  not bleed into a review and vice versa (spec §6). */
  activeMode: ModeId
  onCite: (cite: CiteTarget) => void
}): React.JSX.Element {
  const [findings, setFindings] = useState<FindingRow[]>([])
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [clearError, setClearError] = useState<string | null>(null)
  const [layerFilter, setLayerFilter] = useState<ReviewLayerId | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actingId, setActingId] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [worktreeHead, setWorktreeHead] = useState<string | null>(null)
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
    void window.argus.findings.list(slug).then(setFindings)
    // Loaded once per findingsBump (not per finding) — the stale check compares every row's
    // recorded head_sha against this one shared value.
    void window.argus.review.worktreeHead(slug).then(setWorktreeHead)
  }, [slug, sessionId, bump])

  // Toggle semantics: clicking the active thumb returns the finding to pending.
  async function setReview(id: number, next: 'accepted' | 'rejected'): Promise<void> {
    const cur = findings.find((f) => f.id === id)?.reviewState
    const state: ReviewState = cur === next ? 'pending' : next
    await window.argus.findings.review(id, state)
    setFindings((prev) => prev.map((f) => (f.id === id ? { ...f, reviewState: state } : f)))
  }

  /**
   * Composition happens in main (it owns the PR binding and the worktree path) and the composed
   * text goes out through the ordinary agent.send path — the same shape as ReviewRunButton, so
   * cancel/queue/mirror behave exactly as they do for a typed message. The actual write is
   * gated later, at the approval card the agent's tool call raises.
   */
  async function runAction(id: number, action: 'comment' | 'apply'): Promise<void> {
    if (sessionId === null || actingId !== null) return
    setActingId(id)
    setActionError(null)
    try {
      const finding = findings.find((f) => f.id === id)
      if (action === 'comment' && finding?.commentBody) {
        // Plan 6 §1: the finding already carries author-facing prose — post it through the
        // approval card directly, no model turn. 'denied' is the user's own click, not an
        // error, so it stays silent. 'no-body' means the mechanism found no stored prose after
        // all (e.g. edited out from under us) — the plan's stated behavior is to fall through
        // to the composed-turn path below, not to surface the internal token as an error.
        const res = await window.argus.review.postFindingComment(slug, sessionId, id)
        if (res.ok) return
        if (res.reason === 'denied') return
        if (res.reason !== 'no-body') {
          // Other reasons are already author-facing sentences (the throw text from
          // findingForCase/resolveCommentTarget) — 'session-dead' is the one internal token
          // left, mapped to a sentence here rather than shown raw.
          setActionError(
            res.reason === 'session-dead'
              ? 'The session is no longer running.'
              : (res.reason ?? 'Post failed.')
          )
          return
        }
        // 'no-body': fall through to compose the turn.
      }
      const prompt = await window.argus.review.composeActionPrompt(slug, sessionId, [id], action)
      await window.argus.agent.send(slug, sessionId, prompt)
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setActingId(null)
    }
  }

  // Findings are case-scoped in the DB but mode-scoped on screen (see the activeMode prop doc).
  const modeFindings = findings.filter((f) => f.mode === activeMode)

  async function clearAll(): Promise<void> {
    const count = modeFindings.length
    const ok = await confirm({
      title: `Clear all ${activeMode} findings for this case?`,
      message: `${count} finding${count === 1 ? '' : 's'} and the matching findings.md sections are removed. ${
        activeMode === 'review' ? 'Investigation' : 'Review'
      } findings are untouched.`,
      confirmLabel: 'Clear all',
      danger: true
    })
    if (!ok) return
    setClearError(null)
    try {
      await window.argus.findings.clear(slug, activeMode)
    } catch (err) {
      setClearError((err as Error).message)
    } finally {
      await window.argus.findings.list(slug).then(setFindings)
    }
  }

  async function applySelected(): Promise<void> {
    if (sessionId === null || actingId !== null || effectiveSelected.length === 0) return
    setActingId(-1) // batch sentinel: disables the per-finding buttons exactly like a single act
    setActionError(null)
    try {
      const prompt = await window.argus.review.composeActionPrompt(
        slug,
        sessionId,
        effectiveSelected,
        'apply'
      )
      await window.argus.agent.send(slug, sessionId, prompt)
      setSelected(new Set())
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setActingId(null)
    }
  }

  // Selection is only ever a REQUEST: ids that left the list (clear-all, new run, a mode
  // switch, filter is irrelevant — selection survives filtering) drop out here with no
  // effect needed.
  const selectable = new Set(
    modeFindings.filter((f) => f.mode === 'review' && f.diffPath).map((f) => f.id)
  )
  const effectiveSelected = [...selected].filter((id) => selectable.has(id))

  // Most-severe first, matching how the review persona is told to rank. Unflavored
  // (investigation) findings sort after every severity, then newest-first as before — the list
  // query already returns id DESC, so a stable sort preserves that inside each bucket.
  const SEVERITY_RANK: Record<string, number> = { critical: 0, major: 1, minor: 2 }
  const rank = (f: FindingRow): number =>
    f.severity ? SEVERITY_RANK[f.severity] : Object.keys(SEVERITY_RANK).length

  // Chips for layers actually present: a filter for a layer with no findings is a dead control.
  const presentLayers = REVIEW_LAYER_ORDER.filter((id) => modeFindings.some((f) => f.layer === id))
  const layerCounts = new Map(
    presentLayers.map((id) => [id, modeFindings.filter((f) => f.layer === id).length])
  )
  // Derived, not authoritative: layerFilter is only state that *asked* to filter. If the
  // finding set changes underneath it (session/mode switch, clear-all, a new run — this pane
  // instance has no key and survives all of those) and the requested layer is no longer
  // present, the filter self-clears here with no extra effect and no dead-end empty state.
  const effectiveFilter =
    layerFilter !== null && presentLayers.includes(layerFilter) ? layerFilter : null
  const shown = modeFindings
    .filter((f) => effectiveFilter === null || f.layer === effectiveFilter)
    .slice()
    .sort((a, b) => rank(a) - rank(b))

  // Rendered in two mutually-exclusive slots below (with/without layer chips) so it sits next
  // to the chips when there are any, and stands alone when there aren't — same button either
  // way, hoisted once rather than duplicated.
  const applySelectedButton =
    effectiveSelected.length > 0 ? (
      <button
        type="button"
        disabled={sessionId === null || actingId !== null}
        title="One approval card and one push for all selected findings. The card offers approve or deny only — to change which findings go, deny and re-select here."
        className="self-start rounded-r1 border border-signal/50 bg-signal/10 px-2 py-0.5 text-[11px] text-ink transition-colors hover:bg-signal/20 disabled:opacity-40"
        onClick={() => void applySelected()}
      >
        Apply selected ({effectiveSelected.length})
      </button>
    ) : null

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between">
        <SectionLabel>
          {modeFindings.length > 0 ? `Findings · ${modeFindings.length}` : 'Findings'}
        </SectionLabel>
        <div className="flex items-center gap-1">
          {modeFindings.length > 0 && (
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
      {actionError && <p className="text-xs text-danger">{actionError}</p>}
      {/* A count suffix (the same "field · value" idiom as the " · sess N" tag below) makes
          the chip read as a control with its own state, not a copy of the finding badge. */}
      {presentLayers.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
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
          {applySelectedButton}
        </div>
      )}
      {effectiveSelected.length > 0 && presentLayers.length === 0 && (
        <div className="flex items-center gap-1">{applySelectedButton}</div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
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
                        repoNames={repoNames}
                        repoCiteSha={f.mode === 'review' ? (f.headSha ?? undefined) : undefined}
                      />
                    </div>
                  )}
                  <div className="flex items-center gap-2 px-2 pb-1.5">
                    {f.mode === 'review' && f.diffPath && (
                      <input
                        type="checkbox"
                        aria-label={`Select finding ${f.id} for batch apply`}
                        className="h-3 w-3 accent-signal"
                        checked={effectiveSelected.includes(f.id)}
                        onChange={() =>
                          setSelected((prev) => {
                            const next = new Set(prev)
                            if (next.has(f.id)) next.delete(f.id)
                            else next.add(f.id)
                            return next
                          })
                        }
                      />
                    )}
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
                    {f.mode === 'review' &&
                      f.headSha &&
                      worktreeHead &&
                      f.headSha !== worktreeHead && (
                        <span
                          className="rounded-r1 border border-warn/50 bg-warn/10 px-1 text-[10px] text-warn"
                          title={`Recorded at ${f.headSha.slice(0, 12)} — the checked-out PR head is now ${worktreeHead.slice(0, 12)}. The preview is pinned to the recorded commit; re-verify before acting.`}
                        >
                          code moved
                        </span>
                      )}
                    {f.commentUrl && (
                      <a
                        href={f.commentUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-r1 border border-hair2 px-1 text-[10px] text-mute hover:text-ink"
                      >
                        commented
                      </a>
                    )}
                    {f.pushedSha && (
                      <span
                        title={`Pushed ${f.pushedSha}`}
                        className="rounded-r1 border border-review/35 px-1 font-mono text-[10px] text-review"
                      >
                        {f.pushedSha.slice(0, 7)}
                      </span>
                    )}
                    <span className="flex-1" />
                    {f.mode === 'review' && (
                      <>
                        <button
                          aria-label="Post as PR comment"
                          title={
                            f.diffPath
                              ? 'Post this finding as an inline PR comment'
                              : 'No diff anchor — this finding cannot be an inline comment'
                          }
                          disabled={sessionId === null || actingId !== null || !f.diffPath}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-r2 border border-hair2 text-mute transition-colors hover:text-ink disabled:opacity-40"
                          onClick={() => void runAction(f.id, 'comment')}
                        >
                          <MessageSquarePlus size={13} />
                        </button>
                        <button
                          aria-label="Apply change and push"
                          title={
                            !f.diffPath
                              ? 'No diff anchor — this finding cites no code to change'
                              : f.suggestedChange
                                ? 'Apply the suggested change in the PR worktree and push it'
                                : 'Apply a fix in the PR worktree and push it (no suggested change recorded)'
                          }
                          disabled={sessionId === null || actingId !== null || !f.diffPath}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-r2 border border-hair2 text-mute transition-colors hover:text-ink disabled:opacity-40"
                          onClick={() => void runAction(f.id, 'apply')}
                        >
                          <GitCommitVertical size={13} />
                        </button>
                      </>
                    )}
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
            {modeFindings.length > 0 ? 'No findings match this filter.' : 'No findings yet.'}
          </p>
        )}
      </div>
    </div>
  )
}
