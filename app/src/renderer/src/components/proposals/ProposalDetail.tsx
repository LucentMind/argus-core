import { useState } from 'react'
import { Btn, Chip } from '../ui'
import { MessageView } from '../MessageView'
import { SharePushDialog } from '../settings/SharePushDialog'
import { FileRail, BODY_PATH } from './FileRail'
import {
  UnifiedDiff,
  SplitDiff,
  ProposedView,
  NewFileView,
  CodeView,
  diffStat,
  isMarkdownPath,
  type DiffViewMode
} from './DiffViews'
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
  /** The proposal carried at least one executable sibling, computed from `p.files` at accept
   *  time (same expression the pending row uses) — main's accept response only returns the
   *  target it wrote, not the sibling list, so this must be captured before that happens. */
  hasExec: boolean
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
  onReject,
  selectedPath,
  onSelectPath,
  editedPaths
}: {
  /** the selected pending proposal, or null when `accepted` is set or nothing selected */
  proposal: ProposalRecord | null
  /** the selected accepted entry, or null */
  accepted: AcceptedEntry | null
  busy: boolean
  /** non-null = edit mode, holds the draft for whichever path is selected */
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
  /** Which file the rail has selected; `BODY_PATH` for the proposal body. */
  selectedPath: string
  onSelectPath: (path: string) => void
  /** Paths that currently have an open edit buffer (Edit was toggled on for them), for the
   *  rail's "edited" marker — not diffed against the draft, so a buffer that round-trips the
   *  original text is still flagged. */
  editedPaths: ReadonlySet<string>
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
  const hasFiles = (p.files?.length ?? 0) > 0
  const selectedFile = hasFiles ? p.files!.find((f) => f.path === selectedPath) : undefined
  // The body is the fallback for `BODY_PATH` and for a selection that no longer exists (the
  // record can refresh under the pane while a sibling is selected).
  const sel = selectedFile ?? { path: BODY_PATH, content: p.content, current: p.current }
  const selIsBody = sel.path === BODY_PATH

  // A sibling is Markdown only if its path says so AND it isn't executable — `exec` is also true
  // for a `#!`-shebang file regardless of extension (isExecutableAsset, shared/skillAssets.ts),
  // so a `.md`-named script must still route to CodeView, not MessageView, or its shebang line
  // renders as an `<h1>` and its indentation collapses. The body always renders as Markdown.
  const renderAsMarkdown = selIsBody ? true : isMarkdownPath(sel.path) && !selectedFile?.exec
  // `writeProposal` refuses `files` for non-skill types, so the agent write path can never reach
  // this branch with a sibling selected — but the app also supports proposals hand-seeded into
  // `proposals/` externally, and `listProposals` attaches `files` for any directory-shaped
  // proposal regardless of `type`. Keying purely on `p.type` would still route a selected `.sh`
  // sibling of a hand-seeded `case-summary` through MessageView, so this also has to consult
  // which file is actually selected (`renderAsMarkdown`, which already carries the F1 exec gate).
  const isMarkdown = p.type === 'case-summary' && renderAsMarkdown
  // A new file has no `current` to diff against, so it gets neither a diff nor the view toggle
  // over it (user-directed, 2026-08-08) — every mode would have shown the same single column of
  // added lines. Same shape as the case-summary branch: rendered content, no view bar.
  const isNewFile = sel.current === null
  const isEditing = editValue !== null
  const showViewBar = !isMarkdown && !isNewFile && !isEditing
  const stat = !isMarkdown && !isNewFile ? diffStat(sel.current, sel.content) : null

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
          {/* Hidden entirely for a files-carrying proposal (user-directed): the rail's own
              per-entry "new" marker is the signal there, and following the selected file here
              could show "Skill · edit", "→ collect-logs" and "new file" together for a
              skill-edit proposal that only adds a new sibling — contradicting the queue row,
              which is right (it's an edit). For a flat proposal this keeps its pre-increment
              meaning: `sel.current` is `p.current` when there is no rail to select against. */}
          {!hasFiles && sel.current === null && <Chip tone="review">new file</Chip>}
          {p.previouslyReviewed && <Chip tone="review">previously reviewed</Chip>}
          {p.locked && <Chip tone="review">ships with a pack</Chip>}
        </div>
        {p.locked && (
          <div className="mt-1 text-xs text-dim">
            Ships with a pack (or Argus core) — contribute to the pack, or to Argus itself, to
            change this.
          </div>
        )}
        {p.basis && (
          <p className="mt-2 border-l-2 border-hair pl-2 text-xs italic text-dim">
            Basis: {p.basis}
          </p>
        )}
        {p.priorReject && (
          <div
            role="status"
            className="mt-2 rounded-r2 border border-review/40 bg-review/10 px-2 py-1 text-xs text-ink"
          >
            {'Previously rejected'}
            {p.priorReject.tag ? (
              <>
                {' as '}
                <b>{p.priorReject.tag}</b>
              </>
            ) : null}
            {` (case ${p.priorReject.caseSlug})`}
            {p.priorReject.note ? `: ${p.priorReject.note}` : ''}
          </div>
        )}
      </div>
      {hasFiles && (
        <FileRail
          files={p.files!}
          body={{ current: p.current, content: p.content }}
          selected={sel.path}
          onSelect={onSelectPath}
          editedPaths={editedPaths}
        />
      )}
      {showViewBar && (
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
            <MessageView markdown={sel.content} onCite={noop} />
          </div>
        ) : isNewFile && !renderAsMarkdown ? (
          // A brand-new script or data file: verbatim, no Markdown pass. A MODIFIED sibling
          // still falls through to the diff below — UnifiedDiff/SplitDiff/ProposedView are
          // plain `<pre>` line renderers that cannot eat a `#` as a heading, so there is no
          // lossy-rendering hazard on that path, and the diff is exactly what a reviewer of a
          // changed file wants to see.
          <CodeView content={sel.content} />
        ) : isNewFile ? (
          <NewFileView content={sel.content} />
        ) : viewMode === 'split' ? (
          <SplitDiff current={sel.current} content={sel.content} />
        ) : viewMode === 'proposed' ? (
          <ProposedView content={sel.content} />
        ) : (
          <UnifiedDiff current={sel.current} content={sel.content} />
        )}
      </div>
      {rejecting && (
        <div className="flex flex-wrap items-center gap-2 border-t border-hair px-5 py-3">
          <span className="text-xs text-mute">
            Why? Pick a reason to reject (labels the distill-eval corpus)
          </span>
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
            placeholder="or write your own reason"
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy && rejectNote.trim()) {
                e.preventDefault()
                onReject({ tag: 'other', note: rejectNote.trim() })
              }
            }}
            className="min-w-40 rounded-r2 border border-hair bg-transparent px-2 py-0.5 text-xs text-ink"
          />
          {rejectNote.trim() ? (
            <Btn
              variant="dangerSolid"
              aria-label="Reject with this note"
              disabled={busy}
              onClick={() => onReject({ tag: 'other', note: rejectNote.trim() })}
            >
              Reject
            </Btn>
          ) : (
            <Btn
              variant="ghost"
              aria-label="Reject without a reason"
              disabled={busy}
              onClick={() => onReject(undefined)}
            >
              Skip reason
            </Btn>
          )}
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
