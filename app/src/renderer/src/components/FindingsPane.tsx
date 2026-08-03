import { useEffect, useState, useSyncExternalStore } from 'react'
import { FileText, PanelRight, Trash2 } from 'lucide-react'
import { usePendingDisplay } from '../lib/usePendingDisplay'
import { agentStore, EMPTY_CASE_AGENT_STATE } from '../lib/agentStore'
import { confirm } from '../lib/confirmStore'
import { reposStore } from '../lib/reposStore'
import { uiStore } from '../lib/uiStore'
import type { FindingRow, ReviewState } from '../../../shared/observability'
import { REVIEW_LAYERS, REVIEW_LAYER_ORDER } from '../../../shared/reviewLayers'
import type { ReviewLayerId } from '../../../shared/reviewLayers'
import type { ModeId } from '../../../shared/modes'
import type { CiteTarget } from '../lib/citations'
import { FindingCard } from './FindingCard'
import { IconBtn, SectionLabel, SkeletonRows } from './ui'

export function FindingsPane({
  slug,
  sessionId,
  activeMode,
  onCite,
  onOpenRca
}: {
  slug: string
  sessionId: number | null
  /** Findings are case-scoped in the DB but mode-scoped on screen: investigation findings do
   *  not bleed into a review and vice versa (spec §6). */
  activeMode: ModeId
  onCite: (cite: CiteTarget) => void
  /** Opens the RCA review panel (part 3a-N) — undefined in any caller that has no such panel
   *  (e.g. a future non-case use of this pane). Rendered only in investigation mode: the
   *  report is built from investigation findings, and review mode has no such concept. */
  onOpenRca?: () => void
}): React.JSX.Element {
  const [findings, setFindings] = useState<FindingRow[]>([])
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [clearError, setClearError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [layerFilter, setLayerFilter] = useState<ReviewLayerId | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actingId, setActingId] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [worktreeHead, setWorktreeHead] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [rcaBump, setRcaBump] = useState(0)
  const showSkeleton = usePendingDisplay(!loaded)
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const dynamic = ui.dynamicTheme
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoaded(false)
    void window.argus.findings.list(slug).then(
      (rows) => {
        setFindings(rows)
        setLoaded(true)
      },
      (err) => {
        // `loaded` on rejection too, so a failed fetch does not leave the pane skeletal forever.
        // The findings are deliberately NOT cleared: a rejected fetch has not established that
        // there are none, and a `bump`-triggered refetch that fails would otherwise wipe findings
        // already on screen and replace them with "No findings yet." — the exact false claim this
        // task exists to remove. (Cross-case leak of those stale findings is prevented by the
        // `key={slug}` at the CaseWorkspace call site, not by anything here.)
        console.warn(`[findings] list failed for ${slug}: ${(err as Error).message}`)
        setLoaded(true)
      }
    )
    // Loaded once per findingsBump (not per finding) — the stale check compares every row's
    // recorded head_sha against this one shared value. Deliberately NOT part of `loaded`:
    // it drives a staleness badge and must not hold the whole pane.
    void window.argus.review.worktreeHead(slug).then(setWorktreeHead)
  }, [slug, sessionId, bump, rcaBump])

  // `RcaJobs.confirm` writes role assignments straight to the DB (findings.ts's
  // applyReportRoles), which no `bump` (agentStore's findingsBump, fired only for
  // agent-emitted findings) ever observes — without this, role chips/pinning only appear
  // after a manual refetch (switching mode, remounting the pane). Same subscribe/bump
  // pattern as `agentStore` above, scoped to this pane's own slug.
  useEffect(() => {
    const unsub = window.argus.rca.onRcaChanged((p) => {
      if (p.caseSlug === slug) setRcaBump((n) => n + 1)
    })
    return unsub
  }, [slug])

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
      await window.argus.agent.send(slug, sessionId, prompt, true)
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

  /** Per-finding hard delete: findings.md splice, DB row, and audit all happen in the main
   *  process (deleteFinding); this confirms, calls it, and only drops the row locally on
   *  success — no refetch needed since the service has already committed the removal. Mirrors
   *  `clearAll`'s try/catch → error-state shape: an unknown id, a second window's concurrent
   *  delete, or an fs error must surface here rather than becoming an unhandled rejection with
   *  the card silently staying on screen with no explanation. */
  async function onDelete(id: number): Promise<void> {
    const f = findings.find((x) => x.id === id)
    const ok = await confirm({
      title: 'Delete finding?',
      message: f?.summary ?? `Finding ${id}`,
      danger: true
    })
    if (!ok) return
    setDeleteError(null)
    try {
      await window.argus.findings.delete(id)
      setFindings((prev) => prev.filter((x) => x.id !== id))
    } catch (err) {
      setDeleteError((err as Error).message)
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
      await window.argus.agent.send(slug, sessionId, prompt, true)
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
  // finding set changes underneath it (session/mode switch, clear-all, a new run — the pane is
  // keyed by slug, so it survives all of those without a remount) and the requested layer is no
  // longer present, the filter self-clears here with no extra effect and no dead-end empty state.
  const effectiveFilter =
    layerFilter !== null && presentLayers.includes(layerFilter) ? layerFilter : null
  const shown = modeFindings
    .filter((f) => effectiveFilter === null || f.layer === effectiveFilter)
    .slice()
    .sort((a, b) => rank(a) - rank(b))

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* `h-8 shrink-0`, and first in the rail: this row is the findings rail's chrome row, and
          its twin is the workspace rail's (see CaseWorkspace). Both sit at their aside's `p-3`
          inset and are the same height, which is what puts the two collapse toggles on one
          line — they used to disagree by however tall the workspace rail's Jira card was.
          `h-8`, not the original `h-6`: this row also has to land on the centre column's
          PanelTabStrip chrome row once that moved above the card too. This row itself stays
          bare (outside the card below) — that is what keeps the toggle aligned with its
          opposite number, exactly as CaseWorkspace's chrome row stays outside its scroll box. */}
      <div className="flex h-8 shrink-0 items-center justify-between">
        <SectionLabel>
          {modeFindings.length > 0 ? `Findings · ${modeFindings.length}` : 'Findings'}
        </SectionLabel>
        <div className="flex items-center gap-1">
          {modeFindings.length > 0 && (
            <>
              <button
                aria-label="Clear findings"
                title="Clear all findings"
                className="rounded-r1 px-1.5 py-0.5 text-mute transition-colors hover:bg-hair hover:text-danger"
                onClick={() => void clearAll()}
              >
                <Trash2 size={14} strokeWidth={1.5} />
              </button>
              {/* Clear-findings is the only control in this cluster with consequences; the rule
                  keeps it from reading as a peer of the panel toggle. */}
              <span
                aria-hidden="true"
                data-testid="clear-rule"
                className="mx-0.5 h-3 w-px bg-hair2"
              />
            </>
          )}
          {/* Investigation-only: the RCA report is built from investigation findings and has
              no review-mode analog (part 3a-N). */}
          {activeMode === 'investigation' && onOpenRca && (
            <IconBtn size="sm" aria-label="RCA report" title="RCA report" onClick={onOpenRca}>
              <FileText size={14} strokeWidth={1.5} />
            </IconBtn>
          )}
          {/* Same `IconBtn size="sm"` as the workspace rail's toggle — identical box in an
              identical row is what makes the two land on the same y, so this is not a free
              swap for a raw button. */}
          <IconBtn
            size="sm"
            aria-label="Collapse findings"
            title="Collapse findings"
            onClick={() => uiStore.setFindingsCollapsed(true)}
          >
            <PanelRight size={14} strokeWidth={1.5} />
          </IconBtn>
        </div>
      </div>
      {/* Everything below the chrome row, carded: the workspace rail reads bare chrome row then
          card sections (JiraSection, ReposSection, ...), so the findings rail mirrors that
          instead of leaving the chrome row floating over loose text. Same idiom ReposSection
          uses for its own card. `flex-1 min-h-0` so the card fills the rail's remaining height,
          with the scrolling list living inside it (below) rather than the card itself scrolling.
          FindingsPane is not in legibilityLine.test.tsx's DENSE list (only FindingCard is), so
          material on this wrapper is fine — FindingCard itself stays bare. */}
      <div
        className={`flex min-h-0 flex-1 flex-col gap-2 rounded-r3 p-2.5 ${dynamic ? 'glass-panel' : 'surface-card'}`}
      >
        {clearError && <p className="text-xs text-danger">{clearError}</p>}
        {deleteError && <p className="text-xs text-danger">{deleteError}</p>}
        {actionError && <p className="text-xs text-danger">{actionError}</p>}
        {/* A count suffix (the same "field · value" idiom as the " · sess N" stamp in
            FindingCard.tsx) makes the chip read as a control with its own state, not a copy of
            another element on the card — there is no finding badge any more. */}
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
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* `showSkeleton` alone is not enough to gate the skeleton: `loaded` resets to false on
              every `bump`, and `bump` fires for EVERY finding an agent emits during a run, not just
              a case/session switch. If that refetch is slow enough to cross usePendingDisplay's
              150ms delay, a skeleton-only guard would win ahead of `shown.length > 0` and replace
              findings the user is reading with grey blocks — a refetch must never blank content
              already on screen. `shown.length === 0` keeps the skeleton exclusive with the list,
              same as ReposSection's `workspaces.length === 0` guard. */}
          {showSkeleton && shown.length === 0 ? (
            <SkeletonRows count={3} />
          ) : shown.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {shown.map((f) => (
                <FindingCard
                  key={f.id}
                  finding={f}
                  slug={slug}
                  open={expandedId === f.id}
                  selected={effectiveSelected.includes(f.id)}
                  selectable={selectable.has(f.id)}
                  sessionId={sessionId}
                  actingId={actingId}
                  worktreeHead={worktreeHead}
                  repoNames={repoNames}
                  onToggle={() => {
                    if (f.body) setExpandedId(expandedId === f.id ? null : f.id)
                  }}
                  onSelect={() =>
                    setSelected((prev) => {
                      const next = new Set(prev)
                      if (next.has(f.id)) next.delete(f.id)
                      else next.add(f.id)
                      return next
                    })
                  }
                  onReview={(next) => void setReview(f.id, next)}
                  onAction={(action) => void runAction(f.id, action)}
                  onCite={onCite}
                  onDelete={(id) => void onDelete(id)}
                />
              ))}
            </ul>
          ) : loaded ? (
            <p className="text-xs text-mute">
              {modeFindings.length > 0 ? 'No findings match this filter.' : 'No findings yet.'}
            </p>
          ) : null}
        </div>
        {/* Selection is a batch action, not a filter — it gets its own row below the list, and it
            only exists while something is selected. Footer, not header: it summarizes the list
            above it. */}
        {effectiveSelected.length > 0 && (
          <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-hair pt-2">
            <span className="whitespace-nowrap font-mono text-[11px] text-mute">
              <span className="text-ink">{effectiveSelected.length}</span> selected
            </span>
            <button
              type="button"
              aria-label="Clear selection"
              className="whitespace-nowrap rounded-r1 px-1 font-mono text-[10.5px] text-mute transition-colors hover:text-ink"
              onClick={() => setSelected(new Set())}
            >
              clear
            </button>
            <button
              type="button"
              disabled={sessionId === null || actingId !== null}
              title="One approval card and one push for all selected findings. The card offers approve or deny only — to change which findings go, deny and re-select here."
              className="ml-auto whitespace-nowrap rounded-r1 border border-signal/50 bg-signal/10 px-2 py-0.5 text-[11px] text-ink transition-colors hover:bg-signal/20 disabled:opacity-40"
              onClick={() => void applySelected()}
            >
              Apply selected ({effectiveSelected.length})
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
