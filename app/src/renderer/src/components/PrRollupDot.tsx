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
  running: { className: 'bg-defect animate-pulse', label: 'Checks running' },
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
