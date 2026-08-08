import { Fragment } from 'react'
import { diffLines, pairRows } from '../../lib/lineDiff'
import type { DiffCell } from '../../lib/lineDiff'
import { KIND_PREFIX, KIND_CLASS } from './diffUtils'

export type { DiffViewMode } from './diffUtils'
// eslint-disable-next-line react-refresh/only-export-components -- re-export of a pure helper co-located with the diff components that consume it; see ToolRow.tsx for the same pattern
export { diffStat } from './diffUtils'

export function UnifiedDiff({
  current,
  content
}: {
  current: string | null
  content: string
}): React.JSX.Element {
  const lines = diffLines(current ?? '', content)
  return (
    <pre className="whitespace-pre-wrap px-4 py-3 font-mono text-xs">
      {lines.map((l, i) => (
        <div key={i} className={KIND_CLASS[l.kind]}>
          {KIND_PREFIX[l.kind]}
          {l.text}
        </div>
      ))}
    </pre>
  )
}

/** One side of a split row; null cell = filler opposite an unpaired add/del. */
function SplitCell({ cell }: { cell: DiffCell | null }): React.JSX.Element {
  return (
    <>
      <span className="select-none px-2 text-right text-faint">{cell?.no ?? ''}</span>
      <span
        className={`whitespace-pre-wrap pr-3 ${
          cell
            ? `${KIND_CLASS[cell.kind]} ${
                cell.kind === 'add' ? 'bg-signal/5' : cell.kind === 'del' ? 'bg-danger/5' : ''
              }`
            : 'bg-hair/30'
        }`}
      >
        {cell?.text ?? ''}
      </span>
    </>
  )
}

export function SplitDiff({
  current,
  content
}: {
  current: string | null
  content: string
}): React.JSX.Element {
  const rows = pairRows(diffLines(current ?? '', content))
  return (
    <div className="overflow-x-auto py-3 font-mono text-xs">
      <div className="grid min-w-fit grid-cols-[auto_1fr_auto_1fr]">
        {rows.map((r, i) => (
          <Fragment key={i}>
            <SplitCell cell={r.left} />
            <SplitCell cell={r.right} />
          </Fragment>
        ))}
      </div>
    </div>
  )
}

export function ProposedView({ content }: { content: string }): React.JSX.Element {
  return <pre className="whitespace-pre-wrap px-4 py-3 font-mono text-xs text-dim">{content}</pre>
}
