import { useState } from 'react'
import { Btn, Chip } from '../ui'
import { MessageView } from '../MessageView'
import { SharePushDialog } from '../settings/SharePushDialog'
import { UnifiedDiff, SplitDiff, ProposedView, diffStat, type DiffViewMode } from './DiffViews'
import {
  PROPOSAL_TYPE_LABELS,
  REJECT_REASON_TAGS,
  REJECT_REASON_LABELS
} from '../../../../shared/proposals'
import type {
  AcceptedTarget,
  ProposalRecord,
  ProposalType,
  RejectReason,
  RejectReasonTag
} from '../../../../shared/proposals'

const noop = (): void => undefined

export interface AcceptedEntry {
  file: string
  title: string
  caseSlug: string
  date: string
  type: ProposalType
  target: AcceptedTarget
}

const VIEW_MODES: { mode: DiffViewMode; label: string; aria: string }[] = [
  { mode: 'unified', label: 'Unified', aria: 'Unified view' },
  { mode: 'split', label: 'Split', aria: 'Split view' },
  { mode: 'proposed', label: 'Proposed', aria: 'Proposed view' }
]

export function ProposalDetail({
  proposal,
  accepted,
  busy,
  editValue,
  onEditChange,
  onToggleEdit,
  viewMode,
  onViewMode,
  position,
  repoSet,
  onOpenHivemind,
  onAccept,
  onReject
}: {
  /** the selected pending proposal, or null when `accepted` is set or nothing selected */
  proposal: ProposalRecord | null
  /** the selected accepted entry, or null */
  accepted: AcceptedEntry | null
  busy: boolean
  /** non-null = edit mode, holds the draft */
  editValue: string | null
  onEditChange: (v: string) => void
  onToggleEdit: () => void
  viewMode: DiffViewMode
  onViewMode: (m: DiffViewMode) => void
  /** 1-based position among filtered pending, or null for accepted/empty */
  position: { index: number; total: number } | null
  repoSet: boolean
  onOpenHivemind: () => void
  onAccept: () => void
  onReject: (reason: RejectReason | undefined) => void
}): React.JSX.Element {
  const [rejecting, setRejecting] = useState(false)
  const [rejectNote, setRejectNote] = useState('')
  const [sharing, setSharing] = useState(false)

  if (accepted) {
    const pushKind =
      accepted.target.kind === 'skill' || accepted.target.kind === 'reference'
        ? accepted.target.kind
        : null
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8">
        <Chip tone="signal">accepted</Chip>
        <div className="text-sm text-ink">“{accepted.title}” accepted into your library.</div>
        {pushKind && repoSet && (
          <Btn
            variant="outline"
            aria-label={`Share to HiveMind: ${accepted.target.name}`}
            onClick={() => setSharing((s) => !s)}
          >
            Share to HiveMind
          </Btn>
        )}
        {pushKind && !repoSet && (
          <Btn variant="ghost" onClick={onOpenHivemind}>
            Set up HiveMind to share →
          </Btn>
        )}
        {pushKind && sharing && (
          <SharePushDialog
            kind={pushKind}
            name={accepted.target.name}
            onClose={() => setSharing(false)}
          />
        )}
      </div>
    )
  }

  if (!proposal) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-sm text-dim">
        No pending proposals — the agent drafts them during sessions (write_proposal /
        /contribute-back) and after case distillation.
      </div>
    )
  }

  const p = proposal
  const isMarkdown = p.type === 'case-summary'
  const isEditing = editValue !== null
  const stat = !isMarkdown ? diffStat(p.current, p.content) : null

  return (
    // `min-w-0`: this is a flex item of the surface-card row in ProposalsStandalone
    // (queue + detail); flex's default min-width:auto lets a long-unbroken-line diff grow
    // this pane to its content's intrinsic width instead of the row's allotted space, and
    // the card's overflow-hidden then clips it with no scrollbar. jsdom cannot see this;
    // live-verified 2026-08-08.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-b border-hair px-5 py-4">
        <h2 className="text-[15px] font-medium text-ink">{p.title}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-mute">
          <Chip tone="neutral">{PROPOSAL_TYPE_LABELS[p.type]}</Chip>
          {!isMarkdown && <Chip tone="neutral">→ {p.target}</Chip>}
          <span>{new Date(p.date).toLocaleString()}</span>
          {p.current === null && <Chip tone="review">new file</Chip>}
          {p.previouslyReviewed && <Chip tone="review">previously reviewed</Chip>}
          {p.locked && <Chip tone="review">ships with a pack</Chip>}
        </div>
        {p.locked && (
          <div className="mt-1 text-xs text-dim">
            Ships with a pack (or Argus core) — contribute to the pack, or to Argus itself, to
            change this.
          </div>
        )}
      </div>
      {!isMarkdown && !isEditing && (
        <div className="flex items-center gap-2 border-b border-hair px-5 py-2">
          <div className="flex overflow-hidden rounded-r2 border border-hair2">
            {VIEW_MODES.map((v) => (
              <button
                key={v.mode}
                aria-label={v.aria}
                aria-pressed={viewMode === v.mode}
                onClick={() => onViewMode(v.mode)}
                className={`px-2.5 py-0.5 text-xs transition-colors ${
                  viewMode === v.mode ? 'bg-overlay text-ink' : 'text-dim hover:text-ink'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
          {stat && (
            <span className="ml-auto font-mono text-xs">
              <span className="text-signal">+{stat.adds}</span>{' '}
              <span className="text-danger">−{stat.dels}</span>
            </span>
          )}
        </div>
      )}
      {/* `min-w-0`: same flex min-width:auto constraint as the root above, one level down —
          without it this pane still balloons to the diff's intrinsic width before the
          SplitDiff/UnifiedDiff `overflow-x-auto`/wrap can engage. jsdom cannot see this;
          live-verified 2026-08-08. */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {isEditing ? (
          <textarea
            aria-label="Edit proposal content"
            className="h-full w-full resize-none whitespace-pre-wrap bg-transparent px-5 py-3 font-mono text-xs text-ink focus:outline-none"
            value={editValue}
            onChange={(e) => onEditChange(e.target.value)}
          />
        ) : isMarkdown ? (
          <div className="px-5 py-3">
            <MessageView markdown={p.content} onCite={noop} />
          </div>
        ) : viewMode === 'split' ? (
          <SplitDiff current={p.current} content={p.content} />
        ) : viewMode === 'proposed' ? (
          <ProposedView content={p.content} />
        ) : (
          <UnifiedDiff current={p.current} content={p.content} />
        )}
      </div>
      {rejecting && (
        <div className="flex flex-wrap items-center gap-2 border-t border-hair px-5 py-3">
          <span className="text-xs text-mute">Why? (labels the distill-eval corpus)</span>
          {REJECT_REASON_TAGS.map((tag: RejectReasonTag) => (
            <button
              key={tag}
              aria-label={`Reject as ${tag}`}
              disabled={busy}
              className="rounded-full border border-hair px-2 py-0.5 text-xs text-dim hover:text-ink"
              onClick={() =>
                onReject({ tag, ...(rejectNote.trim() ? { note: rejectNote.trim() } : {}) })
              }
            >
              {REJECT_REASON_LABELS[tag]}
            </button>
          ))}
          <input
            aria-label="Reject note"
            placeholder="optional note"
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            className="min-w-40 rounded-r2 border border-hair bg-transparent px-2 py-0.5 text-xs text-ink"
          />
          <Btn
            variant="ghost"
            aria-label="Reject without a reason"
            disabled={busy}
            onClick={() => onReject(undefined)}
          >
            Skip reason
          </Btn>
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-hair px-5 py-3">
        <Btn
          variant="primary"
          aria-label={`Accept ${p.title}`}
          disabled={busy || p.locked}
          title={p.locked ? 'Ships with a pack — contribute there instead' : undefined}
          onClick={onAccept}
        >
          Accept
        </Btn>
        <Btn
          variant="outline"
          aria-label={`Edit ${p.title}`}
          disabled={busy}
          onClick={onToggleEdit}
        >
          {isEditing ? 'View diff' : 'Edit'}
        </Btn>
        <Btn
          variant="dangerSolid"
          aria-label={`Reject ${p.title}`}
          disabled={busy}
          onClick={() => {
            setRejectNote('')
            setRejecting((r) => !r)
          }}
        >
          Reject…
        </Btn>
        {position && (
          <span className="ml-auto text-xs text-mute">
            {position.index} of {position.total}
          </span>
        )}
      </div>
    </div>
  )
}
