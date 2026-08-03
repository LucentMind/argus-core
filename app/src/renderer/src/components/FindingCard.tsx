import { useState } from 'react'
import {
  ChevronRight,
  GitCommitVertical,
  MessageSquarePlus,
  ThumbsDown,
  ThumbsUp,
  Trash2
} from 'lucide-react'
import { REVIEW_LAYERS } from '../../../shared/reviewLayers'
import type { ReviewSeverity } from '../../../shared/reviewLayers'
import type { FindingRow } from '../../../shared/observability'
import type { CiteTarget } from '../lib/citations'
import { MessageView } from './MessageView'
import { IconBtn } from './ui'

/** Module-private on purpose: `react-refresh/only-export-components` forbids a second export
 *  from a file that exports a component. */
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

/** Severity is an ordinal axis, so it gets one consistent treatment across all three values —
 *  previously `critical` was a filled red pill, `major` a filled blue one, and `minor` bare
 *  mute text, which made severity impossible to compare down the list. */
const SEVERITY_TEXT: Record<ReviewSeverity, string> = {
  critical: 'text-danger',
  major: 'text-defect',
  minor: 'text-dim'
}

/** Severity as a vertical scan line. 2px on the card edge costs no horizontal space, which the
 *  meta row cannot spare at FINDINGS_MIN_WIDTH. */
const SEVERITY_RAIL: Record<ReviewSeverity, string> = {
  critical: 'bg-danger',
  major: 'bg-defect',
  minor: 'bg-mute'
}

/** One finding in the sidebar list. Presentational: every mutation goes back up through a
 *  callback so FindingsPane keeps sole ownership of state and IPC. */
export function FindingCard({
  finding: f,
  slug,
  open,
  selected,
  selectable,
  sessionId,
  actingId,
  worktreeHead,
  repoNames,
  onToggle,
  onSelect,
  onReview,
  onAction,
  onCite,
  onDelete
}: {
  finding: FindingRow
  slug: string
  open: boolean
  selected: boolean
  selectable: boolean
  sessionId: number | null
  actingId: number | null
  worktreeHead: string | null
  repoNames: readonly string[]
  onToggle: () => void
  onSelect: () => void
  onReview: (next: 'accepted' | 'rejected') => void
  onAction: (action: 'comment' | 'apply') => void
  onCite: (cite: CiteTarget) => void
  onDelete: (id: number) => void
}): React.JSX.Element {
  const accepted = f.reviewState === 'accepted'
  const rejected = f.reviewState === 'rejected'
  const [actFocus, setActFocus] = useState(false)
  return (
    <li
      className={`group/f relative rounded-r2 border bg-panel ${
        accepted ? 'border-review/35' : rejected ? 'border-danger/35' : 'border-hair'
      }`}
    >
      {f.severity && (
        <span
          aria-hidden="true"
          data-severity={f.severity}
          className={`absolute top-0 bottom-0 left-0 w-[2px] rounded-l-r2 ${SEVERITY_RAIL[f.severity]}`}
        />
      )}
      <div className="flex items-start gap-1.5 py-1.5 pr-2 pl-3">
        <ChevronRight
          size={13}
          className={`mt-0.5 shrink-0 text-mute transition-transform ${open ? 'rotate-90' : ''} ${
            f.body ? '' : 'opacity-0'
          }`}
        />
        <button
          className="flex-1 text-left text-xs leading-snug text-ink disabled:cursor-default"
          disabled={!f.body}
          aria-expanded={f.body ? open : undefined}
          onClick={onToggle}
        >
          {f.summary}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pr-2 pb-1.5 pl-3">
        {selectable && (
          <input
            type="checkbox"
            aria-label={`Select finding ${f.id} for batch apply`}
            className="h-3 w-3 shrink-0 accent-signal"
            checked={selected}
            onChange={onSelect}
          />
        )}
        {(f.severity || f.layer) && (
          <span className="flex min-w-0 items-center gap-1 whitespace-nowrap font-mono text-[10px]">
            {f.severity && (
              <span className={`shrink-0 ${SEVERITY_TEXT[f.severity]}`}>{f.severity}</span>
            )}
            {f.severity && f.layer && <span className="text-faint">·</span>}
            {/* Not the only shrinkable cell — the timestamp in the trailing cell is too, and it
                yields first. "Design conformance" does not ellipsize at any pane width, measured:
                `flex-wrap` breaks the row onto a new line before this cell gives up any width. */}
            {f.layer && <span className="truncate text-mute">{REVIEW_LAYERS[f.layer].label}</span>}
          </span>
        )}
        {f.mode === 'review' && f.headSha && worktreeHead && f.headSha !== worktreeHead && (
          <span
            className="shrink-0 rounded-r1 border border-defect/50 bg-defect/10 px-1 text-[10px] text-defect"
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
            className="shrink-0 rounded-r1 border border-hair2 px-1 text-[10px] text-mute hover:text-ink"
          >
            commented
          </a>
        )}
        {f.pushedSha && (
          <span
            title={`Pushed ${f.pushedSha}`}
            className="shrink-0 rounded-r1 border border-review/35 px-1 font-mono text-[10px] text-review"
          >
            {f.pushedSha.slice(0, 7)}
          </span>
        )}
        {/* Provenance and actions share one cell: provenance in flow, the cluster absolutely
            positioned over it. The two never sum — the cell shares one slot between them — but
            what actually makes the row fit at FINDINGS_MIN_WIDTH is `flex-wrap` on the meta row,
            not the shared slot alone. `opacity-0` and not `hidden` on purpose — a display-none
            subtree is untabbable, and these buttons are the only keyboard path to comment/apply. */}
        <div
          data-testid="finding-trailing"
          className="relative ml-auto flex h-6 min-w-0 items-center"
          onFocus={() => setActFocus(true)}
          onBlur={() => setActFocus(false)}
        >
          <span
            className={`min-w-0 truncate font-mono text-[10px] text-mute transition-opacity group-hover/f:opacity-0 ${actFocus ? 'opacity-0' : ''}`}
          >
            {formatWhen(f.createdAt)}
            {f.sessionId != null ? ` · sess ${f.sessionId}` : ''}
          </span>
          <div
            className={`absolute right-0 flex items-center gap-0.5 rounded-r1 bg-panel transition-opacity ${
              actFocus ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
            } group-hover/f:pointer-events-auto group-hover/f:opacity-100`}
          >
            {f.mode === 'review' ? (
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
                  onClick={() => onAction('comment')}
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
                  onClick={() => onAction('apply')}
                >
                  <GitCommitVertical size={13} />
                </button>
              </>
            ) : (
              <>
                <button
                  aria-label="Mark finding good"
                  aria-pressed={accepted}
                  title="Good finding"
                  className={`inline-flex h-6 w-6 items-center justify-center rounded-r2 border transition-colors ${
                    accepted
                      ? 'border-review bg-review/15 text-review'
                      : 'border-hair2 text-mute hover:text-ink'
                  }`}
                  onClick={() => onReview('accepted')}
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
                  onClick={() => onReview('rejected')}
                >
                  <ThumbsDown size={13} />
                </button>
              </>
            )}
            {/* Hard delete, available in both modes — same hover-reveal cluster as the
                review/write-action buttons above, so it never adds a second reveal affordance.
                `!` markers on the hover color/border: IconBtn's own `hover:text-ink` is equal
                specificity, so a bare appended `hover:text-danger` loses on stylesheet source
                order alone (see CaseAnchor.tsx's triggerClassName for the same trap). */}
            <IconBtn
              size="sm"
              aria-label="Delete finding"
              title="Delete finding"
              className="border border-hair2 hover:border-danger/50! hover:text-danger!"
              onClick={() => onDelete(f.id)}
            >
              <Trash2 size={13} />
            </IconBtn>
          </div>
        </div>
      </div>
      {open && f.body && (
        <div className="border-t border-hair py-2 pr-2 pl-3 text-xs">
          <MessageView
            markdown={f.body}
            onCite={onCite}
            caseSlug={slug}
            repoNames={repoNames}
            repoCiteSha={f.mode === 'review' ? (f.headSha ?? undefined) : undefined}
          />
        </div>
      )}
    </li>
  )
}
