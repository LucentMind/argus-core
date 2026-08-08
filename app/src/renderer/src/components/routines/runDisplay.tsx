import { useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Chip } from '../ui'
import { MARKDOWN_COMPONENTS } from '../../lib/markdownLinks'
import type { RoutineRunSummary } from '../../../../shared/routines'

/**
 * How a run renders, in one place, because two surfaces now render runs: the Settings history
 * and the Home inbox. The same run shown two different ways in two places is exactly the drift
 * this increment exists to remove.
 */

/**
 * Four tones for four outcomes. `timeout` and `running` deliberately do NOT share a tone with
 * `failed`/`ok`: a user scanning unattended work is asking "did my overnight work happen?", and
 * a run cut off at its time limit, or one still going, are both wrong answers to read as a
 * clean pass.
 */
// eslint-disable-next-line react-refresh/only-export-components -- constant co-located with the components it configures; see MetricCards.tsx for the same pattern
export const RUN_TONE: Record<
  RoutineRunSummary['status'],
  'signal' | 'danger' | 'defect' | 'review'
> = {
  ok: 'signal',
  failed: 'danger',
  timeout: 'defect',
  running: 'review'
}

/**
 * What started this run.
 *
 * Renders for all three triggers, INCLUDING manual — the inbox's whole question is "did this
 * happen on its own?", so the answer must be on every row. The Settings history keeps its own
 * rule of hiding the manual case (a history where most rows are manual reads better without
 * it) by not rendering this component for manual runs; the rule lives at that call site rather
 * than here, so the inbox is not constrained by it.
 */
export function TriggerChip({ run }: { run: RoutineRunSummary }): React.JSX.Element {
  const label =
    run.trigger === 'catchup' ? 'catch-up' : run.trigger === 'scheduled' ? 'scheduled' : 'manual'
  return (
    <Chip tone="neutral">
      <span data-testid={`run-trigger-${run.id}`}>{label}</span>
    </Chip>
  )
}

/** Beyond this many characters, a run's summary or error is cut and gets a toggle. */
const TRUNCATE_AT = 200

/**
 * A run's summary or error: markdown, truncated until asked for.
 *
 * TRUNCATED IN JS, NOT BY `line-clamp`, so the cut is real. jsdom resolves no stylesheet, so a
 * CSS-only clamp would leave the whole string in the DOM and no test in this suite could tell
 * readable from hidden.
 *
 * The slice is taken on the RAW text, before parsing, which can cut markdown mid-syntax — an
 * unterminated fence renders as a code block running to the end of the excerpt. Accepted:
 * expanding shows the correct whole, and a cut a test can observe is worth more than one that
 * is always syntactically clean.
 *
 * Module scope, not nested in a row component: `react-hooks/static-components`, and a component
 * redeclared per render would drop its open/closed state on every payload refresh.
 */
export function RunSummaryText({
  text,
  kind
}: {
  text: string
  kind: 'summary' | 'error'
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const long = text.length > TRUNCATE_AT
  const shown = open || !long ? text : `${text.slice(0, TRUNCATE_AT)}…`
  return (
    <div className={kind === 'error' ? 'text-danger' : 'text-dim'}>
      {/* No rehype-raw in this subtree: the text is model output, and raw HTML from a model is
          not something to inject into the renderer. Same posture as HitDetail. */}
      <div className="markdown-body">
        <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
          {shown}
        </Markdown>
      </div>
      {long && (
        <button
          type="button"
          className="whitespace-nowrap text-mute underline transition-colors hover:text-ink"
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}
