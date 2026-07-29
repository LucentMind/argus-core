import type { PrRollup } from '../../../shared/prStatus'

/**
 * The one CI indicator, shared by the companion header, the case-header chip and the dashboard
 * cards, so those three can never drift into three colour vocabularies. Colour is never the only
 * signal: each state carries a distinct accessible name.
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
