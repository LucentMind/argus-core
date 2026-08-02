import {
  CircleCheck,
  CircleX,
  CircleAlert,
  LoaderCircle,
  Circle,
  CircleHelp,
  GitPullRequest,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  GitMergeConflict
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PrRollup } from '../../../shared/prStatus'
import { prFaceOf, type PrFace, type PrStatus } from '../../../shared/prStatus'

/**
 * The one CI indicator. This dot form is shared by the companion header (HeaderChips.tsx) and
 * the case-header chip (PrCompanionSection.tsx). The dashboard cards use `PrFaceIcon` below
 * (off the separate `FACE` map, which covers the whole PR state, not just CI) — `PrRollupIcon`
 * further down has no production caller today. Colour is never the only signal: each state
 * carries a distinct accessible name.
 *
 * `bg-signal` (the app's positive accent) rather than a literal green: it is the only "good"
 * token with a light-theme override, and this palette has no green that survives on paper.
 */
const TONE: Record<PrRollup, { className: string; label: string }> = {
  passing: { className: 'bg-signal', label: 'Checks passing' },
  failing: { className: 'bg-danger', label: 'Checks failing' },
  // Amber like `running`, so it must differ in shape as well: solid here, a ring there. The
  // app has no prefers-reduced-motion rule, and a pulse should not be the only difference
  // between "still going" and "something already failed".
  //
  // The label is deliberately vague: `unstable` covers two different causes — a non-gating
  // failure, and a gating check that was cancelled (which neither failed nor is unblocked) —
  // and this component only receives the rollup, not the checks, so it cannot tell which one
  // applies. The list beneath the dot can; it names each check's own state.
  unstable: { className: 'bg-defect', label: 'Some checks did not pass' },
  running: {
    className: 'border border-defect bg-transparent animate-pulse',
    label: 'Checks running'
  },
  none: { className: 'bg-hair2', label: 'No checks' },
  unavailable: { className: 'border border-mute bg-transparent', label: 'Status unavailable' }
}

export function PrRollupDot({
  rollup,
  size = 8
}: {
  rollup: PrRollup
  size?: number
}): React.JSX.Element {
  const tone = TONE[rollup]
  return (
    <span
      role="img"
      aria-label={tone.label}
      title={tone.label}
      style={{ width: size, height: size }}
      className={`inline-block shrink-0 rounded-full ${tone.className}`}
    />
  )
}

/**
 * The footer form of the same signal. Each state's accessible name is derived from `TONE` to
 * keep them in sync. Colour comes from the same token set as `TONE`, but as `text-*` (an icon
 * strokes with currentColor, it does not fill with a background). Only `none` actually swaps
 * tokens here — its TONE background is `--hair-2`, unsuited to an icon stroke, so the icon form
 * falls back to `text-mute`; `unavailable`'s TONE already uses the `mute` token (a `border-mute`
 * outline), so its icon form needs no substitution at all. Each state additionally differs in
 * glyph — so the states stay distinguishable where two of them share amber, and without relying
 * on animation as the only cue.
 */
const ICON: Record<PrRollup, { Glyph: LucideIcon; className: string; label: string }> = {
  passing: { Glyph: CircleCheck, className: 'text-signal', label: TONE.passing.label },
  failing: { Glyph: CircleX, className: 'text-danger', label: TONE.failing.label },
  unstable: { Glyph: CircleAlert, className: 'text-defect', label: TONE.unstable.label },
  running: { Glyph: LoaderCircle, className: 'text-defect', label: TONE.running.label },
  none: { Glyph: Circle, className: 'text-mute', label: TONE.none.label },
  unavailable: { Glyph: CircleHelp, className: 'text-mute', label: TONE.unavailable.label }
}

export function PrRollupIcon({
  rollup,
  size = 13
}: {
  rollup: PrRollup
  size?: number
}): React.JSX.Element {
  const { Glyph, className, label } = ICON[rollup]
  return (
    <span role="img" aria-label={label} title={label} className={`inline-flex ${className}`}>
      <Glyph size={size} aria-hidden="true" />
    </span>
  )
}

/**
 * The dashboard card's PR glyph. Unlike `PrRollupIcon` (CI only) this covers the whole
 * pull-request state, because on a card there is no accompanying text to say "merged".
 *
 * `GitPullRequestClosed` deliberately serves two faces — grey for a PR closed without
 * merging, red for a failed build. Colour and tooltip carry the distinction; the glyph is
 * the one the vocabulary assigns to failure.
 *
 * Every colour is an existing theme token with a light-theme override (theme.css), so this
 * needs no palette work: review #8bdca5/#1e8f5c, danger #f27a6b/#c93b3b,
 * defect #f3c352/#b3760a, analytics #c2a6fa/#7351c9.
 */
const FACE: Record<PrFace, { Glyph: LucideIcon; className: string; label: string }> = {
  merged: { Glyph: GitPullRequest, className: 'text-analytics', label: 'merged' },
  closed: { Glyph: GitPullRequestClosed, className: 'text-mute', label: 'closed without merging' },
  conflict: { Glyph: GitMergeConflict, className: 'text-defect', label: 'merge conflict' },
  draft: { Glyph: GitPullRequestDraft, className: 'text-mute', label: 'draft' },
  passing: { Glyph: GitPullRequestArrow, className: 'text-review', label: 'checks passing' },
  failing: { Glyph: GitPullRequestClosed, className: 'text-danger', label: 'checks failing' },
  unstable: {
    Glyph: GitPullRequestClosed,
    className: 'text-defect',
    label: 'some checks did not pass'
  },
  running: {
    Glyph: GitPullRequestArrow,
    className: 'text-defect animate-pulse',
    label: 'checks running'
  },
  none: { Glyph: GitPullRequestArrow, className: 'text-mute', label: 'no checks' },
  unavailable: { Glyph: GitPullRequestArrow, className: 'text-mute', label: 'status unavailable' }
}

export function PrFaceIcon({
  status,
  size = 13
}: {
  status: PrStatus
  size?: number
}): React.JSX.Element {
  const { Glyph, className, label } = FACE[prFaceOf(status)]
  const title = `PR #${status.number} — ${label}`
  return (
    <span role="img" aria-label={title} title={title} className={`inline-flex ${className}`}>
      <Glyph size={size} aria-hidden="true" />
    </span>
  )
}
