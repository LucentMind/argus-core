import { useMemo } from 'react'
import { diffLines, pairRows, type DiffRow } from '../../lib/lineDiff'

const CELL_CLASS = {
  same: 'text-dim',
  add: 'bg-signal/10 text-signal',
  del: 'bg-danger/10 text-danger'
} as const

export interface DiffViewProps {
  before: string
  after: string
  beforeLabel: string
  afterLabel: string
  /** Buttons under the diff. The caller owns the verbs: this component serves assist accept,
   *  save conflict and draft staleness, and none of those three share a word. It is also where
   *  per-hunk accept grows later (spec §9). */
  actions?: React.ReactNode
}

/**
 * The one diff surface for the editor window's three flows (spec §5.6) — assist accept, save
 * conflict, draft staleness — built once so those three do not grow three separate diffs.
 * `references/DiffView.tsx` already exists, for the reference-sync report, with a different
 * shape (`oldText`/`newText`, a split/unified toggle, no `data-kind`, no `actions`); folding the
 * two together is a follow-up, not this increment.
 *
 * Split rather than unified, because the flow that needs it most is "mine" against "on disk",
 * where the two columns are the whole point.
 */
export function DiffView({
  before,
  after,
  beforeLabel,
  afterLabel,
  actions
}: DiffViewProps): React.JSX.Element {
  // diffLines is O(n*m) with its own size guard; memoised so a parent re-render (a banner
  // changing, say) does not recompute a 400k-cell table.
  const rows = useMemo(() => pairRows(diffLines(before, after)), [before, after])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-2 gap-px border-b border-hair bg-hair text-xs">
        <span className="bg-panel px-3 py-1.5 text-dim">{beforeLabel}</span>
        <span className="bg-panel px-3 py-1.5 text-dim">{afterLabel}</span>
      </div>
      <div
        role="group"
        aria-label={`${beforeLabel} compared with ${afterLabel}`}
        className="min-h-0 flex-1 overflow-auto font-mono text-xs leading-5"
      >
        {rows.map((row, i) => (
          <div key={i} className="grid grid-cols-2 gap-px">
            <Side cell={row.left} />
            <Side cell={row.right} />
          </div>
        ))}
      </div>
      {actions && (
        <div className="flex justify-end gap-2 border-t border-hair px-3 py-2">{actions}</div>
      )}
    </div>
  )
}

function Side({ cell }: { cell: DiffRow['left'] }): React.JSX.Element {
  // Filler opposite an unpaired add/del — no data-kind, so it never counts as a change.
  // `bg-hair/20` (Task 10 review finding 6): the previous dark-only black-alpha literal was
  // invisible-to-wrong on a pale ground. `references/DiffView.tsx`'s `SplitDiffRows` already
  // uses `bg-hair/20` for this exact filler; matched here rather than inventing a second token
  // for the same job.
  if (!cell) return <span className="bg-hair/20" />
  return (
    <span
      data-kind={cell.kind}
      className={`flex gap-2 whitespace-pre-wrap px-2 ${CELL_CLASS[cell.kind]}`}
    >
      <span className="w-8 shrink-0 select-none text-right text-faint">{cell.no}</span>
      <span className="min-w-0 flex-1 break-words">{cell.text}</span>
    </span>
  )
}
