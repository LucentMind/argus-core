import { useState } from 'react'
import type { DistillRunDetail } from '../../../../shared/distill'
import type {
  Dossier,
  DossierCite,
  KnowledgeCandidate,
  PreStageDrop,
  StageRecord
} from '../../../../shared/distillV3'
import { Chip } from '../ui'
import { UnifiedDiff } from '../proposals/DiffViews'
import { citeLabel, classifyCandidates } from './runsModel'

function Raw({ text }: { text: string }): React.JSX.Element {
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-r4 bg-panel p-2 font-mono text-[11px] text-ink">
      {text}
    </pre>
  )
}

/** Card shell: header line (name · prompt chars · cost · flags · error), structured|raw toggle. */
export function StageCard({
  id,
  name,
  record,
  structured,
  children
}: {
  id: string
  name: string
  record: StageRecord | undefined
  /** false when nothing parsed — the card is raw-only and the toggle is hidden. */
  structured: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  const [raw, setRaw] = useState(!structured)
  return (
    <section
      id={`card-${id}`}
      data-testid={`card-${id}`}
      className="flex flex-col gap-2 rounded-r2 surface-card p-3"
    >
      <header className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-dim">
        <span className="text-ink">{name}</span>
        {record ? (
          <>
            <span>{record.promptChars} prompt chars</span>
            {record.usage?.costUsd !== undefined && <span>${record.usage.costUsd.toFixed(2)}</span>}
            {record.flags?.length ? <Chip tone="defect">{record.flags.join(', ')}</Chip> : null}
          </>
        ) : (
          <span>not reached</span>
        )}
        {record && structured && (
          <button
            type="button"
            className="ml-auto text-dim underline decoration-dotted hover:text-ink"
            aria-label={`${raw ? 'Show structured' : 'Show raw'} ${name}`}
            onClick={() => setRaw(!raw)}
          >
            {raw ? 'structured' : 'raw'}
          </button>
        )}
      </header>
      {record?.error && <div className="font-mono text-[11px] text-danger">{record.error}</div>}
      {record && (raw ? <Raw text={record.rawOutput} /> : children)}
    </section>
  )
}

export function Cites({ cites }: { cites: DossierCite[] }): React.JSX.Element {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {cites.map((c, i) => (
        <Chip key={i} tone="neutral">
          {citeLabel(c)}
        </Chip>
      ))}
    </span>
  )
}

export function DossierBody({
  d,
  uncited
}: {
  d: Dossier
  uncited?: Record<string, number>
}): React.JSX.Element {
  const line = (
    label: string,
    x: { text: string; cites: DossierCite[] } | null
  ): React.JSX.Element => (
    <div className="text-xs">
      <span className="text-dim">{label} </span>
      {x ? (
        <>
          {x.text} <Cites cites={x.cites} />
        </>
      ) : (
        <span className="text-mute">null</span>
      )}
    </div>
  )
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-r1 bg-hair/40 px-2 py-1 text-xs">
        <span className="text-dim">scope </span>
        {d.scope.status}
        {d.scope.resolution ? ` / ${d.scope.resolution}` : ''} ·{' '}
        {d.scope.settled ? 'settled' : 'unsettled'} · {d.scope.note}
      </div>
      {line('root cause', d.root_cause)}
      {line(
        'confirmed fix',
        d.confirmed_fix
          ? {
              text: `${d.confirmed_fix.text}${d.confirmed_fix.applied ? ' (applied)' : ''}`,
              cites: d.confirmed_fix.cites
            }
          : null
      )}
      <div className="text-xs text-dim">diagnostic path ({d.diagnostic_path.length})</div>
      <ol className="ml-4 list-decimal text-xs">
        {d.diagnostic_path.map((s, i) => (
          <li key={i}>
            <span>{s.step}</span> <span className="text-dim">— {s.observation}</span>{' '}
            <span className="text-mute">· {s.discriminated}</span> <Cites cites={s.cites} />
          </li>
        ))}
      </ol>
      <div className="text-xs text-dim">durable facts ({d.durable_facts.length})</div>
      <ul className="ml-4 list-disc text-xs">
        {d.durable_facts.map((f, i) => (
          <li key={i}>
            {f.fact}
            {f.scope && <span className="text-dim"> [{f.scope}]</span>} <Cites cites={f.cites} />
            <details className="text-mute">
              <summary>quote</summary>
              {f.quote}
            </details>
          </li>
        ))}
      </ul>
      {d.rejected_hypotheses.length > 0 && (
        <>
          <div className="text-xs text-dim">
            rejected hypotheses ({d.rejected_hypotheses.length})
          </div>
          <ul className="ml-4 list-disc text-xs">
            {d.rejected_hypotheses.map((h, i) => (
              <li key={i}>
                {h.text} <span className="text-dim">— {h.how_ruled_out}</span>{' '}
                <Cites cites={h.cites} />
              </li>
            ))}
          </ul>
        </>
      )}
      {d.user_corrections.length > 0 && (
        <>
          <div className="text-xs text-dim">user corrections ({d.user_corrections.length})</div>
          <ul className="ml-4 list-disc text-xs">
            {d.user_corrections.map((u, i) => (
              <li key={i}>
                {u.text} <Cites cites={u.cites} />
              </li>
            ))}
          </ul>
        </>
      )}
      {uncited && (
        <div className="font-mono text-[10px] text-mute">
          uncited items dropped:{' '}
          {Object.entries(uncited)
            .map(([k, n]) => `${k} ×${n}`)
            .join(', ')}
        </div>
      )}
    </div>
  )
}

export function CandidatesBody({
  candidates,
  dropped,
  malformed
}: {
  candidates: KnowledgeCandidate[]
  dropped: PreStageDrop[]
  malformed?: number
}): React.JSX.Element {
  const rows = classifyCandidates(candidates, dropped)
  return (
    <div className="flex flex-col gap-1">
      {rows.map(({ candidate: c, verdict }, i) => (
        <div
          key={i}
          data-testid="candidate-row"
          className="rounded-r1 border border-hair px-2 py-1 text-xs"
        >
          <div className="flex flex-wrap items-center gap-2">
            {verdict.kind === 'kept' ? (
              <Chip tone="signal">kept</Chip>
            ) : (
              <Chip tone="danger">vetoed · {verdict.reason}</Chip>
            )}
            <Chip tone="neutral">{c.kind}</Chip>
            <span className="font-mono text-dim">{c.type}</span>
            <span className="font-mono text-ink">{c.target}</span>
            <span className="text-dim">conf {c.confidence.toFixed(2)}</span>
          </div>
          <div className="mt-1 text-ink">{c.title}</div>
          <div className="text-dim">{c.outline}</div>
          <div className="font-mono text-[10px] text-mute">
            evidence: {c.evidence.join(', ')}
            {c.related.length ? ` · related: ${c.related.join(', ')}` : ''}
          </div>
          <details className="text-[11px] text-mute">
            <summary>routing rationale</summary>
            {c.routing_rationale} — {c.generalization}
          </details>
        </div>
      ))}
      {malformed !== undefined && (
        <div className="font-mono text-[10px] text-mute">
          malformed candidates dropped: {malformed}
        </div>
      )}
    </div>
  )
}

export function MaterializeBody({
  m
}: {
  m: NonNullable<DistillRunDetail['parsed']['materialized']>[number]
}): React.JSX.Element {
  if (!m.output) return <span className="text-xs text-mute">did not parse</span>
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div>
        <span className="text-dim">basis </span>
        {m.output.basis}
      </div>
      {m.output.supersedes?.length ? (
        <div className="text-dim">
          supersedes: {m.output.supersedes.map((s) => `${s.asset} (${s.note})`).join('; ')}
        </div>
      ) : null}
      {m.output.file && <Raw text={m.output.file} />}
      {m.output.ops?.map((op, i) => (
        <div key={i} className="font-mono text-[11px]">
          <span className="text-dim">
            {op.op}
            {op.heading ? ` · ${op.heading}` : ''}
          </span>
          <Raw text={op.content} />
        </div>
      ))}
      {m.output.whole_file && (
        <>
          <Chip tone="defect">whole file</Chip>
          <Raw text={m.output.whole_file} />
        </>
      )}
      {m.diff && (
        <div className="rounded-r1 border border-hair">
          <div className="px-2 py-1 font-mono text-[10px] text-mute">
            diff against current file (the at-run-time text is not stored)
          </div>
          <UnifiedDiff current={m.diff.current} content={m.diff.applied} />
        </div>
      )}
    </div>
  )
}
