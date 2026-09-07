import { Fragment } from 'react'
import type { DistillProgress, DistillRunDetail } from '../../../../shared/distill'
import { Chip } from '../ui'
import { PipelineStrip } from './PipelineStrip'
import { StageCard, DossierBody, CandidatesBody, MaterializeBody } from './StageCards'
import { dropBreakdown, isV3Shape, stamp, stripNodes } from './runsModel'

/** One rendered stage of a run, keyed so compare mode can put the same stage of two runs in the
 *  same grid row. Keys match the card DOM ids the pipeline strip scrolls to. */
export interface RunSection {
  key: string
  node: React.ReactNode
}

/** Sort key for a stage, so the union of two runs' stages comes out in pipeline order rather
 *  than in whichever run happened to be on the left. v2's single `agent` card sits where v3's
 *  `dossier` does — they are the same slot in the pipeline, one stage against five. */
// eslint-disable-next-line react-refresh/only-export-components -- the stage ORDER and the stage LIST belong with the component that defines those stages; CompareColumns is their only other consumer and defining them there would invert the dependency.
export function sectionRank(key: string): number {
  const m = /^materialize-(\d+)$/.exec(key)
  if (m) return 400 + Number(m[1])
  const fixed: Record<string, number> = {
    raw: 0,
    dossier: 100,
    agent: 100,
    summary: 200,
    candidates: 300,
    'materialize-none': 400,
    validators: 800,
    trajectory: 900
  }
  return fixed[key] ?? 500
}

/** A metric in the header's second row: a dim label over the value, so seven facts read as
 *  seven labelled facts instead of one run-on mono sentence. */
function Metric({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[9.5px] uppercase tracking-wider text-mute">{label}</span>
      <span className="font-mono text-[11px] text-ink">{value}</span>
    </div>
  )
}

const STATE_TONE = {
  failed: 'danger',
  cancelled: 'defect',
  running: 'signal',
  queued: 'signal'
} as const

/**
 * The identity and the numbers, as two rows rather than one flat line: `#36 NAVPOR-10566 v3 dry
 * run done 2026-09-04 13:06 8 turns 7 tool calls $2.26` gave every one of those equal weight and
 * no separation, so finding the cost meant reading the whole string.
 *
 * `actions` is only ever passed in single-run mode. In compare mode the view owns them, above
 * both columns: the run-level controls act on the SELECTED run, and rendering them inside the
 * left column made that column one row taller than the right — which is what knocked every
 * stage below out of alignment with its counterpart.
 */
export function RunHeader({
  detail,
  compact = false,
  actions
}: {
  detail: DistillRunDetail
  compact?: boolean
  actions?: React.ReactNode
}): React.JSX.Element {
  const job = detail.job
  const tone = STATE_TONE[job.state as keyof typeof STATE_TONE] ?? 'neutral'
  return (
    <header className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-ink">#{job.id}</span>
        {!compact && <span className="font-mono text-xs text-dim">{job.caseSlug}</span>}
        {detail.pipeline && <Chip tone="neutral">{detail.pipeline}</Chip>}
        <Chip tone="neutral">{job.dryRun ? 'dry run' : 'real'}</Chip>
        <Chip tone={tone}>{job.state}</Chip>
        {actions && <span className="ml-auto flex items-center gap-1.5">{actions}</span>}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 border-y border-hair py-1.5">
        <Metric label="finished" value={stamp(job.finishedAt ?? job.createdAt)} />
        {job.turnCount !== null && <Metric label="turns" value={job.turnCount} />}
        {job.toolCallCount !== null && <Metric label="tool calls" value={job.toolCallCount} />}
        {job.costUsd !== null && <Metric label="cost" value={`$${job.costUsd.toFixed(2)}`} />}
        <Metric label="input" value={`${detail.inputSnapshotChars} chars`} />
      </div>
    </header>
  )
}

/** The clickable stage strip, plus the pre-stage drop breakdown and the job error that belong
 *  with it. */
export function RunStrip({
  detail,
  progress
}: {
  detail: DistillRunDetail
  progress: DistillProgress | null
}): React.JSX.Element {
  const job = detail.job
  const s = detail.stages
  const mats = Array.isArray(s?.materialize) ? s.materialize : []
  const scrollTo = (id: string): void => {
    const target =
      id === 'materialize' ? (mats.length > 0 ? 'materialize-0' : 'materialize-none') : id
    document.getElementById(`card-${job.id}-${target}`)?.scrollIntoView({ block: 'start' })
  }
  return (
    <div className="flex flex-col gap-2">
      <PipelineStrip nodes={stripNodes(detail, progress)} onSelect={scrollTo} />
      {detail.dropped.length > 0 && (
        <div className="flex flex-wrap gap-2 font-mono text-[11px] text-dim">
          {dropBreakdown(detail.dropped).map(([r, n]) => (
            <span key={r}>
              {r} ×{n}
            </span>
          ))}
        </div>
      )}
      {job.error && <div className="font-mono text-[11px] text-danger">{job.error}</div>}
    </div>
  )
}

function isTrajectoryEntry(
  e: unknown
): e is { turn: number; tool: string; argsSummary: string; resultBytes?: number } {
  return typeof e === 'object' && e !== null && typeof (e as { tool?: unknown }).tool === 'string'
}

/**
 * Every stage card of a run, as a keyed list. Extracted from `RunDetail`'s body so compare mode
 * can zip two runs' lists into aligned rows instead of standing two independent columns beside
 * each other and hoping they stayed level.
 */
// eslint-disable-next-line react-refresh/only-export-components -- see `sectionRank` above.
export function runSections(detail: DistillRunDetail): RunSection[] {
  const job = detail.job
  const s = detail.stages
  const mats = Array.isArray(s?.materialize) ? s.materialize : []
  const out: RunSection[] = []

  if (isV3Shape(detail)) {
    if (!s && detail.rawOutput !== null)
      // A v3 job with no parsed stages at all (a corrupt `stages_json` column, or a terminal
      // job that failed before writing any stage — see the `stages` field's own doc comment:
      // "the panel is the tool for diagnosing a broken run"). Every per-stage card below
      // renders "not reached" with nothing to show, so without this the raw output — the one
      // thing that DID get recorded — would be invisible.
      out.push({
        key: 'raw',
        node: (
          <StageCard
            id="raw"
            jobId={job.id}
            name="raw output"
            record={{
              promptHash: '',
              promptChars: job.promptChars ?? 0,
              rawOutput: detail.rawOutput
            }}
            structured={false}
          />
        )
      })

    out.push({
      key: 'dossier',
      node: (
        <StageCard
          id="dossier"
          jobId={job.id}
          name="dossier"
          record={s?.dossier}
          structured={detail.parsed.dossier !== null}
        >
          {detail.parsed.dossier && (
            <DossierBody d={detail.parsed.dossier} uncited={s?.dossierUncitedDropped} />
          )}
        </StageCard>
      )
    })

    out.push({
      key: 'summary',
      node: (
        <StageCard
          id="summary"
          jobId={job.id}
          name="summary"
          record={s?.summary}
          structured={detail.parsed.summaryPresent}
        >
          {detail.parsed.summary ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {(['signature', 'symptoms', 'rootCause', 'fix'] as const).map((k) => (
                <Fragment key={k}>
                  <dt className="text-dim">{k}</dt>
                  <dd>{detail.parsed.summary![k]}</dd>
                </Fragment>
              ))}
              <dt className="text-dim">keywords</dt>
              <dd>{detail.parsed.summary.keywords.join(', ')}</dd>
            </dl>
          ) : (
            <span className="text-xs text-mute">null · not recurrence-relevant</span>
          )}
        </StageCard>
      )
    })

    out.push({
      key: 'candidates',
      node: (
        <>
          <StageCard
            id="candidates"
            jobId={job.id}
            name="candidates"
            record={s?.candidates}
            structured={detail.parsed.candidates !== null}
          >
            {detail.parsed.candidates && (
              <CandidatesBody
                candidates={detail.parsed.candidates}
                dropped={detail.dropped}
                malformed={s?.candidatesMalformedDropped}
              />
            )}
          </StageCard>
          {/* The strip's `veto` node has no card of its own — the verdicts live on the candidate
              rows above — so its scroll anchor rides along with them. */}
          <div id={`card-${job.id}-veto`} />
        </>
      )
    })

    if (mats.length === 0)
      out.push({
        key: 'materialize-none',
        node: (
          <section
            id={`card-${job.id}-materialize-none`}
            data-testid="card-materialize-none"
            className="rounded-r2 surface-card p-3 font-mono text-[11px] text-dim"
          >
            materialize —{' '}
            {s?.candidates && !s.candidates.error
              ? 'no candidates survived the veto'
              : 'not reached'}
          </section>
        )
      })

    mats.forEach((m, i) => {
      out.push({
        key: `materialize-${i}`,
        node: (
          <StageCard
            id={`materialize-${i}`}
            jobId={job.id}
            name={`materialize · ${m.type} · ${m.target}`}
            record={m}
            structured={Boolean(detail.parsed.materialized?.[i]?.output)}
          >
            {detail.parsed.materialized?.[i] && (
              <MaterializeBody m={detail.parsed.materialized[i]} />
            )}
          </StageCard>
        )
      })
    })

    // Same as `veto`: a strip node whose findings are reported on the cards above it, and which
    // exists here only as that node's scroll target.
    out.push({ key: 'validators', node: <div id={`card-${job.id}-validators`} /> })
  } else {
    out.push({
      key: 'agent',
      node: (
        <StageCard
          id="agent"
          jobId={job.id}
          name="agent"
          record={
            detail.rawOutput !== null
              ? { promptHash: '', promptChars: job.promptChars ?? 0, rawOutput: detail.rawOutput }
              : undefined
          }
          structured={false}
        />
      )
    })
  }

  const trajectory = Array.isArray(detail.trajectory)
    ? detail.trajectory.filter(isTrajectoryEntry)
    : null
  if (trajectory)
    out.push({
      key: 'trajectory',
      node: (
        <details className="rounded-r2 surface-card p-3">
          <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-wide text-dim">
            Trajectory ({trajectory.length} tool call{trajectory.length === 1 ? '' : 's'})
          </summary>
          <ol className="mt-2 ml-4 list-decimal font-mono text-[11px]">
            {trajectory.map((t, i) => (
              <li key={i}>
                <span className="text-ink">{t.tool}</span>{' '}
                <span className="text-dim">{t.argsSummary}</span>
                {t.resultBytes !== undefined && (
                  <span className="text-mute"> · {t.resultBytes} B</span>
                )}
              </li>
            ))}
          </ol>
        </details>
      )
    })

  return out
}

export function RunDetail({
  detail,
  progress,
  compact = false,
  actions
}: {
  detail: DistillRunDetail
  progress: DistillProgress | null
  /** compare mode: half width, no actions */
  compact?: boolean
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <RunHeader detail={detail} compact={compact} actions={actions} />
      <div className="sticky top-0 z-10 bg-void/90 py-1 backdrop-blur">
        <RunStrip detail={detail} progress={progress} />
      </div>
      {runSections(detail).map((s) => (
        <Fragment key={s.key}>{s.node}</Fragment>
      ))}
    </div>
  )
}
