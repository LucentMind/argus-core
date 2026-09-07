import { useState } from 'react'
import type { DistillRunDetail } from '../../../../shared/distill'
import type {
  Dossier,
  DossierCite,
  KnowledgeCandidate,
  PreStageDrop,
  StageRecord
} from '../../../../shared/distillV3'
import { Btn, Chip } from '../ui'
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
  jobId,
  name,
  record,
  structured,
  children
}: {
  id: string
  /** Namespaces this card's DOM id — compare mode (Task 9) renders two RunDetails side by side. */
  jobId: number
  name: string
  record: StageRecord | undefined
  /** false when nothing parsed — the card is raw-only and the toggle is hidden. */
  structured: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  const [raw, setRaw] = useState(!structured)
  // adjust-state-during-render: a re-fetch of `detail` for a still-mounted card (a running job
  // finishing) can flip `structured` without remounting this component. Land on the structured
  // view when a stage just became parseable, and fall back to raw when it lost its parse — a
  // user's manual toggle still survives unrelated renders (see DistillChip's `prevTracked` for
  // the same idiom).
  const [prevStructured, setPrevStructured] = useState(structured)
  if (structured !== prevStructured) {
    setPrevStructured(structured)
    setRaw(!structured)
  }
  return (
    <section
      id={`card-${jobId}-${id}`}
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
          <Btn
            variant="ghost"
            size="iconXs"
            className="ml-auto w-auto px-2!"
            aria-label={`${raw ? 'Show structured' : 'Show raw'} ${name}`}
            onClick={() => setRaw(!raw)}
          >
            {raw ? 'structured' : 'raw'}
          </Btn>
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

/** A titled block inside the dossier. The count rides in the heading rather than on a line of
 *  its own, so a section is one thing on screen instead of two. */
function DossierSection({
  title,
  count,
  children
}: {
  title: string
  count?: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="flex items-baseline gap-2 border-b border-hair pb-1 font-mono text-[10px] uppercase tracking-widest text-dim">
        {title}
        {count !== undefined && <span className="text-mute">{count}</span>}
      </h4>
      {children}
    </section>
  )
}

/** `root cause` and `confirmed fix` are the two answers the whole dossier exists to produce, so
 *  they are drawn as claims — an accent rule, the prose at reading weight — rather than as two
 *  more `label: value` lines indistinguishable from the metadata around them. A null one keeps
 *  the block (its absence is a finding) but drops the accent. */
function DossierClaim({
  title,
  claim
}: {
  title: string
  claim: { text: string; cites: DossierCite[] } | null
}): React.JSX.Element {
  return (
    <section
      className={`flex flex-col gap-1 rounded-r1 border-l-2 py-1 pl-2.5 ${
        claim ? 'border-signal/50 bg-hair/20' : 'border-hair'
      }`}
    >
      <h4 className="font-mono text-[10px] uppercase tracking-widest text-dim">{title}</h4>
      {claim ? (
        <div className="text-xs text-ink">
          {claim.text} <Cites cites={claim.cites} />
        </div>
      ) : (
        <div className="text-xs text-mute">null</div>
      )}
    </section>
  )
}

export function DossierBody({
  d,
  uncited,
  malformed
}: {
  d: Dossier
  uncited?: Record<string, number>
  malformed?: Record<string, number>
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-r1 bg-hair/40 px-2 py-1 text-xs">
        <span className="text-dim">scope </span>
        {d.scope.status}
        {d.scope.resolution ? ` / ${d.scope.resolution}` : ''} ·{' '}
        {d.scope.settled ? 'settled' : 'unsettled'} · {d.scope.note}
      </div>
      <DossierClaim title="root cause" claim={d.root_cause} />
      <DossierClaim
        title="confirmed fix"
        claim={
          d.confirmed_fix
            ? {
                text: `${d.confirmed_fix.text}${d.confirmed_fix.applied ? ' (applied)' : ''}`,
                cites: d.confirmed_fix.cites
              }
            : null
        }
      />
      <DossierSection title="diagnostic path" count={d.diagnostic_path.length}>
        <ol className="ml-4 list-decimal text-xs">
          {d.diagnostic_path.map((s, i) => (
            <li key={i}>
              <span>{s.step}</span> <span className="text-dim">— {s.observation}</span>{' '}
              <span className="text-mute">· {s.discriminated}</span> <Cites cites={s.cites} />
            </li>
          ))}
        </ol>
      </DossierSection>
      <DossierSection title="durable facts" count={d.durable_facts.length}>
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
      </DossierSection>
      {d.rejected_hypotheses.length > 0 && (
        <DossierSection title="rejected hypotheses" count={d.rejected_hypotheses.length}>
          <ul className="ml-4 list-disc text-xs">
            {d.rejected_hypotheses.map((h, i) => (
              <li key={i}>
                {h.text} <span className="text-dim">— {h.how_ruled_out}</span>{' '}
                <Cites cites={h.cites} />
              </li>
            ))}
          </ul>
        </DossierSection>
      )}
      {d.user_corrections.length > 0 && (
        <DossierSection title="user corrections" count={d.user_corrections.length}>
          <ul className="ml-4 list-disc text-xs">
            {d.user_corrections.map((u, i) => (
              <li key={i}>
                {u.text} <Cites cites={u.cites} />
              </li>
            ))}
          </ul>
        </DossierSection>
      )}
      {malformed && (
        <div className="font-mono text-[10px] text-mute">
          unreadable items dropped:{' '}
          {Object.entries(malformed)
            .map(([k, n]) => `${k} ×${n}`)
            .join(', ')}
        </div>
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
