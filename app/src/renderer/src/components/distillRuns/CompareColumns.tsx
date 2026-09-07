import { Fragment } from 'react'
import type { DistillProgress, DistillRunDetail } from '../../../../shared/distill'
import { RunHeader, RunStrip, runSections, sectionRank, type RunSection } from './RunDetail'

/** Merge two runs' stage keys into one pipeline-ordered list. A stage only one side has still
 *  gets a row — with an empty cell opposite it, which is itself the finding: "this run
 *  materialized three assets and that one materialized two". */
function mergedKeys(a: RunSection[], b: RunSection[]): string[] {
  const all = [...new Set([...a.map((s) => s.key), ...b.map((s) => s.key)])]
  return all.sort((x, y) => sectionRank(x) - sectionRank(y))
}

/** A scroll-anchor-only stage (`validators`; `veto` rides on `candidates`) has no box to
 *  compare, so it must not claim an aligned row — an empty row would open a gap on both sides,
 *  and a "not in this run" placeholder would be a lie about a stage that has no card by design. */
const ANCHOR_ONLY: ReadonlySet<string> = new Set(['validators'])

/** Stands in for a stage the other run has and this one does not. */
function Missing(): React.JSX.Element {
  return (
    <div className="rounded-r2 border border-dashed border-hair p-3 font-mono text-[11px] text-mute">
      not in this run
    </div>
  )
}

/**
 * Two runs of one case, stage against stage.
 *
 * The columns are rows of a single grid rather than two independent stacks: with a stack per
 * run, a taller dossier on the left pushed everything below it down on that side alone, so by
 * the time you reached `materialize` you were reading it against the other run's `candidates`.
 * One grid row per stage makes the taller cell set the row height and leaves the shorter one
 * with whitespace, which is what "compare" needs.
 *
 * The header and the pipeline strip are rows too, for the same reason — and the run-level
 * actions are deliberately NOT here (the view renders them above both columns): inside the left
 * column they made it one row taller than the right, offsetting every stage beneath.
 */
export function CompareColumns({
  a,
  b,
  progressA,
  progressB
}: {
  a: DistillRunDetail
  b: DistillRunDetail
  progressA: DistillProgress | null
  progressB: DistillProgress | null
}): React.JSX.Element {
  const sectionsA = runSections(a)
  const sectionsB = runSections(b)
  const byKeyA = new Map(sectionsA.map((s) => [s.key, s.node]))
  const byKeyB = new Map(sectionsB.map((s) => [s.key, s.node]))
  const keys = mergedKeys(sectionsA, sectionsB).filter((k) => !ANCHOR_ONLY.has(k))

  return (
    <div data-testid="compare-columns" className="grid grid-cols-2 items-start gap-x-4 gap-y-3">
      <RunHeader detail={a} compact />
      <RunHeader detail={b} compact />
      <RunStrip detail={a} progress={progressA} />
      <RunStrip detail={b} progress={progressB} />
      {keys.map((k) => (
        <Fragment key={k}>
          <div className="min-w-0" data-testid={`compare-left-${k}`}>
            {byKeyA.get(k) ?? <Missing />}
          </div>
          <div className="min-w-0" data-testid={`compare-right-${k}`}>
            {byKeyB.get(k) ?? <Missing />}
          </div>
        </Fragment>
      ))}
      {/* Anchor-only stages still need their DOM ids present, or the strip's `validators` node
          scrolls nowhere. Rendered outside the aligned rows, where they cost no height. */}
      {[...ANCHOR_ONLY].map((k) => (
        <div key={`anchor-${k}`} className="col-span-2">
          {byKeyA.get(k)}
          {byKeyB.get(k)}
        </div>
      ))}
    </div>
  )
}
