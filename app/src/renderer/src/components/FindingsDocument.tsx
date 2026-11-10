import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { findingsStore } from '../lib/findingsStore'
import { useReviewWalk } from '../lib/useReviewWalk'
import { useFindingActions } from '../lib/useFindingActions'
import { reposStore } from '../lib/reposStore'
import type { FindingRow } from '../../../shared/observability'
import { buildFindingTree, isInactiveFinding, type TreeNode } from '../../../shared/findingTree'
import type { CiteTarget } from '../lib/citations'
import { FindingCard } from './FindingCard'
import { stageCorrection } from '../lib/correctFinding'
import { SectionLabel } from './ui'

/**
 * The chain read at width (spec 2026-10-26 §9.6): the same tree as the rail, every active body
 * open, each card with its review controls and chain editors; RULED OUT collapsed. Reads the
 * same `findingsStore` as the rail and the inline chat card, so the three never disagree.
 * Investigation mode only — CaseWorkspace mounts it only under the Findings tab, which review
 * mode withdraws.
 */
export function FindingsDocument({
  slug,
  sessionId,
  onCite
}: {
  slug: string
  sessionId: number | null
  onCite: (cite: CiteTarget) => void
}): React.JSX.Element {
  const { rows, loaded } = useSyncExternalStore(
    (cb) => findingsStore.subscribe(cb),
    () => findingsStore.get(slug)
  )
  const repoNames = useSyncExternalStore(
    (cb) => reposStore.subscribe(cb),
    () => reposStore.get(slug)
  ).names
  useEffect(() => {
    void findingsStore.load(slug)
  }, [slug])
  // Bodies are open unless the user collapsed one; the walk's "expand" re-opens the current.
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const actions = useFindingActions(slug, { sessionId, ruledOut: true })
  const { showRuledOut, setShowRuledOut } = actions
  const listRef = useRef<HTMLDivElement>(null)

  const findings = rows.filter((f) => f.mode === 'investigation')
  const tree = buildFindingTree(findings)
  const causeOptions = findings.map((f) => ({
    id: f.id,
    summary: f.summary,
    ...(isInactiveFinding(f) ? { inactive: true } : {})
  }))

  const review = useReviewWalk({
    slug,
    tree,
    listRef,
    onExpand: (id) => {
      if (id !== null)
        setCollapsed((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
    },
    ...actions.walk
  })

  function card(f: FindingRow, depth = 0): React.JSX.Element {
    return (
      <FindingCard
        key={f.id}
        finding={f}
        slug={slug}
        open={!collapsed.has(f.id)}
        selected={false}
        selectable={false}
        sessionId={sessionId}
        actingId={null}
        worktreeHead={null}
        repoNames={repoNames}
        onToggle={() =>
          setCollapsed((prev) => {
            const next = new Set(prev)
            if (next.has(f.id)) next.delete(f.id)
            else next.add(f.id)
            return next
          })
        }
        onSelect={() => {}}
        onReview={(next) => void actions.setReview(f.id, next)}
        onAction={() => {}}
        onCite={onCite}
        onDelete={(id) => void actions.remove(id)}
        onWhy={() => actions.openStrip(f.id)}
        onCorrect={sessionId !== null ? () => stageCorrection(slug, sessionId, f.id) : undefined}
        depth={depth}
        onEdit={(patch) => void actions.edit(f.id, patch)}
        causeOptions={causeOptions}
        footer={actions.footer(f)}
      />
    )
  }
  const section = (label: string, nodes: TreeNode<FindingRow>[]): React.JSX.Element => (
    <section aria-label={label} className="flex flex-col gap-1.5">
      <span aria-hidden="true" className="text-[10px] tracking-wide text-faint uppercase">
        {label}
      </span>
      <ul className="flex flex-col gap-2">{nodes.map((n) => card(n.row, n.depth))}</ul>
    </section>
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-4">
      <div className="flex h-8 shrink-0 items-center justify-between">
        <SectionLabel>
          {findings.length > 0
            ? `Findings · ${findings.length}${tree.pending > 0 ? ` · ${tree.pending} to review` : ''}`
            : 'Findings'}
        </SectionLabel>
        {tree.pending > 0 && !review.walk && (
          <button
            type="button"
            aria-label="Review pending findings"
            title="Walk the pending findings: a accept · r reject · s skip · k back · esc done"
            className="rounded-r1 border border-signal/50 bg-signal/10 px-1.5 py-0.5 text-[10.5px] text-ink transition-colors hover:bg-signal/20"
            onClick={review.start}
          >
            Review
          </button>
        )}
      </div>
      {review.walk && (
        <div
          data-testid="review-walk"
          className="flex shrink-0 items-center gap-2 rounded-r1 border border-signal/35 bg-signal/10 px-2 py-1 font-mono text-[10.5px] text-ink"
        >
          Reviewing {review.walk.i + 1} of {review.walk.ids.length}
          <span className="text-mute">· a accept · r reject · s skip · k back · esc done</span>
        </div>
      )}
      <div
        ref={listRef}
        data-testid="findings-document"
        tabIndex={-1}
        onKeyDown={review.onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto outline-none"
      >
        {findings.length === 0 ? (
          loaded ? (
            <p className="text-xs text-mute">No findings yet.</p>
          ) : null
        ) : (
          <div className="flex flex-col gap-4">
            {tree.rootCause.length > 0 && section('ROOT CAUSE', tree.rootCause)}
            {tree.unexplained.length > 0 && section('UNEXPLAINED', tree.unexplained)}
            {tree.ruledOut.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <button
                  type="button"
                  aria-expanded={showRuledOut}
                  className="self-start text-[10px] tracking-wide text-faint uppercase transition-colors hover:text-ink"
                  onClick={() => setShowRuledOut((v) => !v)}
                >
                  RULED OUT · {tree.ruledOut.length}
                </button>
                {showRuledOut && (
                  <ul aria-label="RULED OUT" className="flex flex-col gap-2">
                    {tree.ruledOut.map((f) => card(f))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
