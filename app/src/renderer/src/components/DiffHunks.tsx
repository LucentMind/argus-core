import { useMemo, useState } from 'react'
import { UnfoldVertical } from 'lucide-react'
import { diffLines, hunks, type DiffSegment } from '../lib/lineDiff'

export interface HunkedDiff {
  segments: DiffSegment[]
  /** A gap the user has opened renders its lines in place instead of a bar. */
  isExpanded: (index: number) => boolean
  expand: (index: number) => void
  expandAll: () => void
  /** Lines still hidden behind unopened gaps; 0 once the whole file is showing. */
  hidden: number
}

/**
 * Diff a pair of documents and cut it into hunks + collapsed gaps, with the per-gap open state
 * the viewers need. Shared by all four diff surfaces (proposals unified/split, the reference
 * sync report, the editor window) so "how much context, and how do I get the rest" is answered
 * in one place rather than four.
 */
// eslint-disable-next-line react-refresh/only-export-components -- a hook co-located with the two bars that are its only UI; splitting them apart would put the diff's open-state contract in one file and its two-line rendering in another. Same pattern as DiffViews.tsx's helper re-exports.
export function useHunkedDiff(before: string, after: string): HunkedDiff {
  const segments = useMemo(() => hunks(diffLines(before, after)), [before, after])
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set<number>())
  // adjust-state-during-render: gaps are addressed by index, and a new pair of documents is a
  // new segment list — carrying the old open set over would open arbitrary gaps in the new
  // diff. `segments` is memoised on the inputs, so identity change IS "the diff changed".
  const [prevSegments, setPrevSegments] = useState(segments)
  if (segments !== prevSegments) {
    setPrevSegments(segments)
    setExpanded(new Set<number>())
  }
  const hidden = segments.reduce(
    (n, s, i) => (s.kind === 'gap' && !expanded.has(i) ? n + s.count : n),
    0
  )
  return {
    segments,
    isExpanded: (i) => expanded.has(i),
    expand: (i) => setExpanded((prev) => new Set(prev).add(i)),
    expandAll: () => setExpanded(new Set(segments.map((_, i) => i))),
    hidden
  }
}

/** The bar standing in for one collapsed run of unchanged lines. Clicking it opens that run. */
export function DiffGapBar({
  count,
  onExpand,
  className = ''
}: {
  count: number
  onExpand: () => void
  className?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="diff-gap"
      aria-label={`Expand ${count} unchanged line${count === 1 ? '' : 's'}`}
      onClick={onExpand}
      className={`flex w-full items-center gap-1.5 border-y border-hair bg-hair/20 px-3 py-0.5 text-left font-mono text-[10px] text-mute transition-colors hover:bg-hair/40 hover:text-dim ${className}`}
    >
      <UnfoldVertical size={10} aria-hidden="true" />
      {count} unchanged line{count === 1 ? '' : 's'}
    </button>
  )
}

/** Header line: how much the hunking is holding back, and the one control that opens all of it.
 *  Renders nothing once every gap is open, so a fully-expanded diff carries no chrome. */
export function DiffHiddenBar({
  hidden,
  onExpandAll,
  className = ''
}: {
  hidden: number
  onExpandAll: () => void
  className?: string
}): React.JSX.Element | null {
  if (hidden === 0) return null
  return (
    <div
      className={`flex items-center justify-end gap-2 px-3 py-1 font-mono text-[10px] text-mute ${className}`}
    >
      <span>{hidden} unchanged lines hidden</span>
      <button
        type="button"
        onClick={onExpandAll}
        className="underline decoration-dotted transition-colors hover:text-ink"
      >
        show whole file
      </button>
    </div>
  )
}
