import { useState } from 'react'
import { pairRows } from '../lib/lineDiff'
import { parseUnifiedDiff } from '../lib/unifiedDiff'
import { DiffModeToggle, SplitDiffRows, UnifiedLines, type DiffMode } from './references/DiffView'

/** Renders server-computed `git diff` text (HiveMind update previews) in the split/unified viewer. */
export function UnifiedDiffView({ diff }: { diff: string }): React.JSX.Element {
  const [mode, setMode] = useState<DiffMode>('split')
  const segs = parseUnifiedDiff(diff)
  if (segs.length === 0) {
    return (
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-dim">
        {diff}
      </pre>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <DiffModeToggle mode={mode} onChange={setMode} />
      <div className="max-h-64 overflow-auto rounded-r2 border border-hair">
        {segs.map((s, i) =>
          s.meta !== undefined ? (
            <div key={i} className="bg-hair/40 px-2 py-0.5 font-mono text-xs text-mute">
              {s.meta}
            </div>
          ) : mode === 'split' ? (
            <SplitDiffRows key={i} rows={pairRows(s.lines, s.leftStart, s.rightStart)} />
          ) : (
            <UnifiedLines key={i} lines={s.lines} />
          )
        )}
      </div>
    </div>
  )
}
