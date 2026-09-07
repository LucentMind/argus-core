import { Fragment, useState } from 'react'
import { pairRows, type DiffLine, type DiffRow } from '../../lib/lineDiff'
import { DiffGapBar, DiffHiddenBar, useHunkedDiff } from '../DiffHunks'

const KIND_PREFIX = { same: '  ', add: '+ ', del: '- ' } as const
const KIND_CLASS = { same: 'text-dim', add: 'text-signal', del: 'text-danger' } as const
const CELL_TINT = {
  same: 'text-dim',
  add: 'bg-signal/10 text-signal',
  del: 'bg-danger/10 text-danger'
} as const

export type DiffMode = 'split' | 'unified'

export function DiffModeToggle({
  mode,
  onChange
}: {
  mode: DiffMode
  onChange: (m: DiffMode) => void
}): React.JSX.Element {
  return (
    <div className="flex gap-1" role="group" aria-label="diff view mode">
      {(['split', 'unified'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          // `bg-well`, not `bg-hi` (Task 12 review finding 1): this toggle's one production call
          // site (UnifiedDiffView, via HivemindSettings) sits inside a SettingsSection card.
          className={`rounded-r2 border px-2 py-0.5 text-xs transition-colors ${
            mode === m ? 'border-hair2 bg-well text-ink' : 'border-hair text-dim hover:text-ink'
          }`}
        >
          {m === 'split' ? 'Split' : 'Unified'}
        </button>
      ))}
    </div>
  )
}

/** Aligned two-column rows: [line no | old text | line no | new text]. */
export function SplitDiffRows({ rows }: { rows: DiffRow[] }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[auto_1fr_auto_1fr] font-mono text-xs">
      {rows.map((r, i) => (
        <Fragment key={i}>
          <div className="select-none border-r border-hair px-1.5 text-right text-mute">
            {r.left?.no ?? ''}
          </div>
          <div
            className={`whitespace-pre-wrap px-2 ${r.left ? CELL_TINT[r.left.kind] : 'bg-hair/20'}`}
          >
            {r.left?.text ?? ''}
          </div>
          <div className="select-none border-x border-hair px-1.5 text-right text-mute">
            {r.right?.no ?? ''}
          </div>
          <div
            className={`whitespace-pre-wrap px-2 ${r.right ? CELL_TINT[r.right.kind] : 'bg-hair/20'}`}
          >
            {r.right?.text ?? ''}
          </div>
        </Fragment>
      ))}
    </div>
  )
}

export function UnifiedLines({ lines }: { lines: DiffLine[] }): React.JSX.Element {
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

export function DiffView({
  oldText,
  newText
}: {
  oldText: string | null
  newText: string
}): React.JSX.Element {
  const [mode, setMode] = useState<DiffMode>('split')
  const d = useHunkedDiff(oldText ?? '', newText)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <DiffModeToggle mode={mode} onChange={setMode} />
        <DiffHiddenBar hidden={d.hidden} onExpandAll={d.expandAll} className="px-0" />
      </div>
      <div className="max-h-64 overflow-auto rounded-r2 border border-hair">
        {d.segments.map((seg, i) =>
          seg.kind === 'gap' && !d.isExpanded(i) ? (
            <DiffGapBar key={i} count={seg.count} onExpand={() => d.expand(i)} />
          ) : mode === 'split' ? (
            <SplitDiffRows key={i} rows={pairRows(seg.lines, seg.leftStart, seg.rightStart)} />
          ) : (
            <UnifiedLines key={i} lines={seg.lines} />
          )
        )}
      </div>
    </div>
  )
}
