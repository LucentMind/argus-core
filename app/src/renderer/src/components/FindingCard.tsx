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
import {
  FINDING_REJECT_LABELS,
  FINDING_ROLE_LABELS,
  FINDING_ROLES
} from '../../../shared/observability'
import { REWIND_REVIEW_REASON } from '../../../shared/branching'
import type { FindingRole, FindingRow } from '../../../shared/observability'
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

/** `caused by #4 · Install rejected`, with `(inactive)` when the cause is no longer active; just
 *  `#4` when the options carry no such row (a cause from a row the store has not loaded). */
function causeLabel(
  id: number,
  options: readonly { id: number; summary: string; inactive?: boolean }[]
): string {
  const o = options.find((x) => x.id === id)
  if (!o) return `caused by #${id}`
  return `caused by #${id} · ${o.summary}${o.inactive ? ' (inactive)' : ''}`
}

/** The select's option text for a stored cause that is no longer active; `#6 (inactive)` when the
 *  options carry no such row. */
function inactiveCauseLabel(
  id: number,
  options: readonly { id: number; summary: string }[]
): string {
  const summary = options.find((o) => o.id === id)?.summary
  return `#${id} ${summary ? `· ${summary} ` : ''}(inactive)`
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
  onDelete,
  onWhy,
  onCorrect,
  footer,
  depth = 0,
  onEdit,
  causeOptions = [],
  note
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
  /** Opens the reject-reason strip for this card (investigation mode only). */
  onWhy?: () => void
  /** Stage a correction into the composer (investigation, not rejected). */
  onCorrect?: () => void
  /** Rendered as the card's last child — the reject strip when this card is being labelled. */
  footer?: React.ReactNode
  /** Tree depth in the rail's chain index; 14px per level. */
  depth?: number
  /** Human chain edit (investigation only). Absent → no editors. */
  onEdit?: (patch: { role?: FindingRole | null; causedBy?: number | null }) => void
  /** Candidates for the cause picker: the case's active investigation findings (self is
   *  filtered here). */
  causeOptions?: readonly { id: number; summary: string; inactive?: boolean }[]
  /** One muted line in the meta row — the inline card's "changed after your accept". */
  note?: string
}): React.JSX.Element {
  const accepted = f.reviewState === 'accepted'
  const rejected = f.reviewState === 'rejected'
  const [actFocus, setActFocus] = useState(false)
  // The agent's evidence claim (spec 2026-10-26 §5.1). Investigation only: a review card
  // renders as before.
  const hypothesis = f.mode === 'investigation' && f.status === 'hypothesis'
  return (
    <li
      data-finding-id={f.id}
      data-status={f.mode === 'investigation' ? f.status : undefined}
      style={f.mode === 'investigation' && depth > 0 ? { marginLeft: depth * 14 } : undefined}
      className={`group/f relative rounded-r2 border bg-panel ${
        accepted ? 'border-review/35' : rejected ? 'border-danger/35' : 'border-hair'
      } ${hypothesis ? 'border-dashed' : ''}`}
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
        {hypothesis && (
          <span
            data-testid="status-chip"
            title="Hypothesis — stated by the agent, not yet evidence-backed"
            className="mt-0.5 shrink-0 rounded-r1 border border-dashed border-hair2 px-1 text-[10px] whitespace-nowrap text-mute"
          >
            ? hypothesis
          </span>
        )}
        {f.role && (
          <span
            title={f.roleSource ? `set by ${f.roleSource}` : undefined}
            className={`mt-0.5 shrink-0 rounded-r1 border px-1 text-[10px] whitespace-nowrap ${
              f.role === 'root-cause' ? 'border-signal/35 text-signal' : 'border-hair2 text-mute'
            }`}
          >
            {FINDING_ROLE_LABELS[f.role]}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pr-2 pb-1.5 pl-3">
        {note && (
          <span
            data-testid="finding-note"
            className="min-w-0 text-[10px] leading-snug text-mute italic"
          >
            {note}
          </span>
        )}
        {rejected && f.reviewActor === 'agent' && (
          <>
            <span className="shrink-0 rounded-r1 border border-danger/35 px-1 text-[10px] whitespace-nowrap text-mute">
              retracted by agent
            </span>
            {f.reviewReason && (
              <span className="min-w-0 text-[10px] leading-snug text-mute">{f.reviewReason}</span>
            )}
          </>
        )}
        {/* The human's label (spec 2026-10-25 §4.4), in the slot the agent chip uses — the two are
            exclusive on the actor. A tagged reject shows the label and the note; an untagged one
            offers a ghost `why?`. Either click reopens the strip, so a label can be added or changed
            later without re-rejecting. Investigation only, and never on a rewound finding (not a judgement): review cards have Post/Apply, not thumbs. */}
        {rejected &&
          f.reviewActor !== 'agent' &&
          f.mode === 'investigation' &&
          f.reviewReason !== REWIND_REVIEW_REASON &&
          (f.rejectTag ? (
            <>
              <button
                type="button"
                aria-label="Change reject reason"
                className="shrink-0 rounded-r1 border border-danger/35 px-1 text-[10px] whitespace-nowrap text-mute hover:text-ink"
                onClick={onWhy}
              >
                {FINDING_REJECT_LABELS[f.rejectTag]}
              </button>
              {f.rejectNote && (
                <span className="min-w-0 text-[10px] leading-snug text-mute">{f.rejectNote}</span>
              )}
            </>
          ) : (
            <button
              type="button"
              aria-label="Add reject reason"
              className="shrink-0 rounded-r1 px-1 text-[10px] text-faint hover:text-ink"
              onClick={onWhy}
            >
              why?
            </button>
          ))}
        {f.mode === 'investigation' && f.causedBy !== null && (
          <span
            data-testid="caused-by-chip"
            className="min-w-0 truncate font-mono text-[10px] text-mute"
          >
            {causeLabel(f.causedBy, causeOptions)}
          </span>
        )}
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
                {onCorrect && !rejected && (
                  <button
                    aria-label="Correct this finding"
                    title="Tell the agent what is wrong — opens the chat with this finding's handle"
                    className="inline-flex h-6 items-center justify-center rounded-r2 border border-hair2 px-1 text-[10px] text-mute transition-colors hover:text-ink"
                    onClick={onCorrect}
                  >
                    Correct
                  </button>
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
      {open && f.mode === 'investigation' && onEdit && (
        <div
          data-testid="chain-editors"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-hair px-3 py-1.5 text-[10.5px] text-mute"
        >
          <label className="flex items-center gap-1">
            role
            <select
              aria-label="Role"
              value={f.role ?? ''}
              onChange={(e) =>
                onEdit({ role: e.target.value === '' ? null : (e.target.value as FindingRole) })
              }
              className="rounded-r1 border border-hair bg-transparent px-1 py-0.5 text-[10.5px] text-ink"
            >
              <option value="">none</option>
              {FINDING_ROLES.map((r) => (
                <option key={r} value={r}>
                  {FINDING_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            caused by
            <select
              aria-label="Caused by"
              value={f.causedBy ?? ''}
              onChange={(e) =>
                onEdit({ causedBy: e.target.value === '' ? null : Number(e.target.value) })
              }
              className="max-w-48 rounded-r1 border border-hair bg-transparent px-1 py-0.5 text-[10.5px] text-ink"
            >
              <option value="">none</option>
              {causeOptions
                .filter((o) => o.id !== f.id && !o.inactive)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    #{o.id} {o.summary}
                  </option>
                ))}
              {/* The stored cause is always an option, even when it is no longer selectable (a
                  rejected / ruled-out / duplicate / superseded row): a controlled select with no
                  matching option shows "none" while the chip says otherwise, and picking "none"
                  would fire no change event, so the dead cause could never be cleared. */}
              {f.causedBy !== null &&
                !causeOptions.some((o) => o.id === f.causedBy && !o.inactive) && (
                  <option key={f.causedBy} value={f.causedBy}>
                    {inactiveCauseLabel(f.causedBy, causeOptions)}
                  </option>
                )}
            </select>
          </label>
        </div>
      )}
      {footer}
    </li>
  )
}
