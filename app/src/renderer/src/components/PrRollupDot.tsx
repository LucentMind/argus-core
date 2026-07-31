import { CircleCheck, CircleX, CircleAlert, LoaderCircle, Circle, CircleHelp } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PrRollup } from '../../../shared/prStatus'

/**
 * The one CI indicator. This dot form is shared by the companion header (HeaderChips.tsx) and
 * the case-header chip (PrCompanionSection.tsx); the dashboard cards use the icon form below
 * (`PrRollupIcon`) instead. Both forms read off the same `TONE` map, so they can never drift
 * into different colour vocabularies. Colour is never the only signal: each state carries a
 * distinct accessible name.
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
