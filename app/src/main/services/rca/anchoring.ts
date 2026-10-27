import type { RcaAnchoring, RcaDraft } from '../../../shared/rca'
import { isInactiveFinding } from '../../../shared/findingTree'

/** The field data behind this (spec 2026-10-27 real-data analysis, internal): a quarter of RCA
 *  statements had no finding behind them. This makes that visible instead of silent. Pure.
 *  `unused` lists the active investigation findings the draft never names — except an active
 *  hypothesis: it is the agent's unconfirmed claim, and the drafter is told (RCA rule 10) never
 *  to put one under the root cause or a contributing cause, so leaving it out is not a gap.
 *  A NULL status is a legacy confirmed finding and is listed. */
export function draftAnchoring(
  draft: RcaDraft,
  findings: readonly {
    id: number
    mode: string
    reviewState: string
    role: string | null
    status?: string | null
    supersededBy?: number | null
  }[]
): RcaAnchoring {
  const named = new Set<number>()
  const count = (items: readonly { findingId: number | null }[]): number => {
    let n = 0
    for (const it of items) {
      if (it.findingId === null) n += 1
      else named.add(it.findingId)
    }
    return n
  }
  const rootCause = count([draft.rootCause])
  const contributing = count(draft.contributing)
  const symptoms = count(draft.symptoms)
  const ruledOut = count(draft.ruledOut)
  for (const d of draft.duplicates) {
    named.add(d.findingId)
    named.add(d.ofFindingId)
  }
  const unused = findings
    .filter(
      (f) =>
        f.mode === 'investigation' &&
        !isInactiveFinding(f) &&
        f.status !== 'hypothesis' &&
        !named.has(f.id)
    )
    .map((f) => f.id)
    .sort((a, b) => a - b)
  return { unanchored: { rootCause, contributing, symptoms, ruledOut }, unused }
}
