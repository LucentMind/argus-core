import { Fragment } from 'react'
import type { DistillProgress, DistillRunDetail } from '../../../../shared/distill'
import { PipelineStrip } from './PipelineStrip'
import { StageCard, DossierBody, CandidatesBody, MaterializeBody } from './StageCards'
import { dropBreakdown, isV3Shape, stamp, stripNodes } from './runsModel'

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
  const job = detail.job
  const nodes = stripNodes(detail, progress)
  const s = detail.stages
  const mats = Array.isArray(s?.materialize) ? s!.materialize : []
  const scrollTo = (id: string): void => {
    const target =
      id === 'materialize' ? (mats.length > 0 ? 'materialize-0' : 'materialize-none') : id
    document.getElementById(`card-${job.id}-${target}`)?.scrollIntoView({ block: 'start' })
  }
  const isTrajectoryEntry = (
    e: unknown
  ): e is { turn: number; tool: string; argsSummary: string; resultBytes?: number } =>
    typeof e === 'object' && e !== null && typeof (e as { tool?: unknown }).tool === 'string'
  const trajectory = Array.isArray(detail.trajectory)
    ? detail.trajectory.filter(isTrajectoryEntry)
    : null
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <header className="flex flex-wrap items-center gap-2 font-mono text-xs">
        <span className="text-ink">#{job.id}</span>
        {!compact && <span className="text-dim">{job.caseSlug}</span>}
        {detail.pipeline && <span className="rounded-r1 bg-hair px-1.5">{detail.pipeline}</span>}
        <span className="text-dim">{job.dryRun ? 'dry run' : 'real'}</span>
        <span className={job.state === 'failed' ? 'text-danger' : 'text-dim'}>{job.state}</span>
        <span className="text-dim">{stamp(job.finishedAt ?? job.createdAt)}</span>
        {job.turnCount !== null && <span className="text-dim">{job.turnCount} turns</span>}
        {job.toolCallCount !== null && (
          <span className="text-dim">{job.toolCallCount} tool calls</span>
        )}
        {job.costUsd !== null && <span className="text-dim">${job.costUsd.toFixed(2)}</span>}
        {actions && <span className="ml-auto flex items-center gap-1">{actions}</span>}
      </header>
      {job.error && <div className="font-mono text-[11px] text-danger">{job.error}</div>}
      <div className="sticky top-0 z-10 bg-void/90 py-1 backdrop-blur">
        <PipelineStrip nodes={nodes} onSelect={scrollTo} />
      </div>
      {detail.dropped.length > 0 && (
        <div className="flex flex-wrap gap-2 font-mono text-[11px] text-dim">
          {dropBreakdown(detail.dropped).map(([r, n]) => (
            <span key={r}>
              {r} ×{n}
            </span>
          ))}
        </div>
      )}

      {isV3Shape(detail) ? (
        <>
          {!s && detail.rawOutput !== null && (
            // A v3 job with no parsed stages at all (a corrupt `stages_json` column, or a
            // terminal job that failed before writing any stage — see the `stages` field's own
            // doc comment: "the panel is the tool for diagnosing a broken run"). Every per-stage
            // card below renders "not reached" with nothing to show, so without this the raw
            // output — the one thing that DID get recorded — would be invisible.
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
          )}
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
          <div id={`card-${job.id}-veto`} />
          {mats.length === 0 && (
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
          )}
          {mats.map((m, i) => (
            <StageCard
              key={i}
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
          ))}
          <div id={`card-${job.id}-validators`} />
        </>
      ) : (
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
      )}

      {trajectory && (
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
      )}
      <div className="font-mono text-[11px] text-dim">
        input snapshot: {detail.inputSnapshotChars} chars
      </div>
    </div>
  )
}
