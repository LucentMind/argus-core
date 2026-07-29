import {
  ChevronRight,
  GitCommitVertical,
  MessageSquarePlus,
  ThumbsDown,
  ThumbsUp
} from 'lucide-react'
import { REVIEW_LAYERS } from '../../../shared/reviewLayers'
import type { ReviewSeverity } from '../../../shared/reviewLayers'
import type { FindingRow } from '../../../shared/observability'
import type { CiteTarget } from '../lib/citations'
import { MessageView } from './MessageView'

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
  onCite
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
}): React.JSX.Element {
  const accepted = f.reviewState === 'accepted'
  const rejected = f.reviewState === 'rejected'
  return (
    <li
      className={`rounded-r2 border bg-panel ${
        accepted ? 'border-review/35' : rejected ? 'border-danger/35' : 'border-hair'
      }`}
    >
      <div className="flex items-start gap-1.5 px-2 py-1.5">
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
      <div className="flex items-center gap-2 px-2 pb-1.5">
        {selectable && (
          <input
            type="checkbox"
            aria-label={`Select finding ${f.id} for batch apply`}
            className="h-3 w-3 shrink-0 accent-signal"
            checked={selected}
            onChange={onSelect}
          />
        )}
        <span className="shrink-0 font-mono text-[10px] text-mute">
          {formatWhen(f.createdAt)}
          {f.sessionId != null ? ` · sess ${f.sessionId}` : ''}
        </span>
        {(f.severity || f.layer) && (
          <span className="flex min-w-0 items-center gap-1 whitespace-nowrap font-mono text-[10px]">
            {f.severity && <span className={SEVERITY_TEXT[f.severity]}>{f.severity}</span>}
            {f.severity && f.layer && <span className="text-faint">·</span>}
            {/* The only shrinkable cell in the row. At FINDINGS_MIN_WIDTH (216px of content)
                "Design conformance" ellipsizes; it used to wrap inside its own pill instead. */}
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
      </div>
      {open && f.body && (
        <div className="border-t border-hair px-2 py-2 text-xs">
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
