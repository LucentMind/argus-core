import { useEffect, useState } from 'react'
import { FlaskConical } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { SkeletonRows } from './ui'
import type { DistillJobRow, DistillRunDetail } from '../../../shared/distill'
import type { StageRecord } from '../../../shared/distillV3'

/** `2026-08-19T10:04:00.000Z` → `2026-08-19 10:04`. Local time, since the reader is comparing
 *  runs they started themselves. */
function stamp(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function runLabel(r: DistillJobRow): string {
  const items = r.dryRun ? 'dry run' : r.itemCount === null ? 'no result' : `${r.itemCount} items`
  return `${r.state} · ${stamp(r.finishedAt ?? r.createdAt)} · ${items}`
}

/** `staged 0 · 5 candidates dropped · 14 turns · 13 tool calls`. A dry row says staging never
 *  ran rather than reporting a zero it never measured — NULL item_count and 0 are different
 *  facts and the panel exists to keep them apart. */
function verdict(d: DistillRunDetail): string {
  const parts: string[] = []
  parts.push(
    d.job.dryRun || d.job.itemCount === null
      ? d.job.dryRun
        ? 'not staged (dry run)'
        : 'not staged'
      : `staged ${d.job.itemCount}`
  )
  if (d.dropped.length) parts.push(`${d.dropped.length} candidates dropped`)
  if (d.job.turnCount !== null) parts.push(`${d.job.turnCount} turns`)
  if (d.job.toolCallCount !== null) parts.push(`${d.job.toolCallCount} tool calls`)
  return parts.join(' · ')
}

/** `reason → count`, in first-seen order so the breakdown reads in drop order like the table. */
function dropBreakdown(d: DistillRunDetail): [string, number][] {
  const counts = new Map<string, number>()
  for (const x of d.dropped) counts.set(x.reason, (counts.get(x.reason) ?? 0) + 1)
  return [...counts.entries()]
}

function StageBlock({
  name,
  testId,
  record
}: {
  name: string
  testId: string
  record: StageRecord | undefined
}): React.JSX.Element {
  return (
    <div data-testid={testId} className="flex flex-col gap-1 border-t border-hair pt-2">
      <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-dim">
        <span className="text-ink">{name}</span>
        {record ? (
          <>
            <span>{record.promptChars} prompt chars</span>
            {record.usage?.costUsd !== undefined && <span>${record.usage.costUsd.toFixed(2)}</span>}
            {record.flags?.length ? <span>flags: {record.flags.join(', ')}</span> : null}
          </>
        ) : (
          <span>not reached</span>
        )}
      </div>
      {record?.error && <div className="font-mono text-[11px] text-danger">{record.error}</div>}
      {record && (
        // Raw output is the point of this panel: never summarized, elided or reformatted.
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-r4 bg-panel p-2 font-mono text-[11px] text-ink">
          {record.rawOutput}
        </pre>
      )}
    </div>
  )
}

/**
 * What a distill run actually produced — the reader for columns the queue has always written
 * and nothing ever displayed. The run picker lists every job for the case (dry runs included),
 * which is how a v2 run and a v3 run for the same case get compared side by side.
 */
export function DistillRunPanel({
  slug,
  onClose
}: {
  slug: string
  onClose: () => void
}): React.JSX.Element {
  const [runs, setRuns] = useState<DistillJobRow[] | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [detail, setDetail] = useState<DistillRunDetail | null>(null)
  // `detail === null` used to mean two different things at once: "still loading" (the common
  // case) and "run(jobId) resolved null" (the id doesn't exist — a stale picker entry, or a row
  // deleted from under the panel). Both rendered the SAME skeleton, so the second case spun
  // forever with no way out. This flag disambiguates them without touching `detail`'s own type
  // or any of the rendering below that already treats a present `detail` as ready.
  const [runNotFound, setRunNotFound] = useState(false)

  useEffect(() => {
    let live = true
    void window.argus.distill
      .runs(slug)
      .then((rs) => {
        if (!live) return
        setRuns(rs)
        setSelected(rs.length ? rs[0].id : null)
      })
      .catch(() => {
        if (live) setRuns([])
      })
    return () => {
      live = false
    }
  }, [slug])

  useEffect(() => {
    if (selected === null) return
    let live = true
    // Deferred to a microtask (the repo's usual set-state-in-effect idiom — see RcaPanel's
    // confirmedAt effect) — a bare setState here would run synchronously in the effect body.
    void Promise.resolve().then(() => {
      if (live) {
        setDetail(null)
        setRunNotFound(false)
      }
    })
    void window.argus.distill
      .run(selected)
      .then((d) => {
        if (!live) return
        setDetail(d)
        setRunNotFound(d === null)
      })
      .catch(() => {
        if (live) {
          setDetail(null)
          setRunNotFound(true)
        }
      })
    return () => {
      live = false
    }
  }, [selected])

  // `stages` is parsed JSON from a hand-serialized column (readRunDetail does not shape-guard
  // it): a corrupt-but-valid-JSON row can hand us a `materialize` that parsed to a string,
  // number or object instead of an array. Guarded here so a broken run — the exact thing this
  // panel exists to diagnose — never throws while rendering.
  const materializeRecords =
    detail && Array.isArray(detail.stages?.materialize) ? detail.stages.materialize : []

  return (
    <ModalShell
      title={
        <>
          <FlaskConical size={14} strokeWidth={1.5} />
          Distillation runs
        </>
      }
      ariaLabel="Distillation runs"
      onClose={onClose}
      className="h-[85vh] w-[880px]"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {runs === null ? (
          <div role="status" aria-label="Loading">
            <SkeletonRows count={4} />
          </div>
        ) : runs.length === 0 ? (
          <div className="py-16 text-center font-mono text-xs text-dim">
            This case has never been distilled.
          </div>
        ) : (
          <>
            <label className="flex items-center gap-2 font-mono text-[11px] text-dim">
              <span>Run</span>
              <select
                aria-label="Run"
                className="rounded-r4 border border-hair bg-panel px-2 py-1 text-ink"
                value={selected ?? ''}
                onChange={(e) => setSelected(Number(e.target.value))}
              >
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {runLabel(r)}
                  </option>
                ))}
              </select>
            </label>

            {detail === null ? (
              runNotFound ? (
                <div className="py-16 text-center font-mono text-xs text-dim">Run not found.</div>
              ) : (
                <div role="status" aria-label="Loading run">
                  <SkeletonRows count={3} />
                </div>
              )
            ) : (
              <>
                <div className="font-mono text-xs text-ink">{verdict(detail)}</div>
                {detail.dropped.length > 0 && (
                  <div className="flex flex-wrap gap-2 font-mono text-[11px] text-dim">
                    {dropBreakdown(detail).map(([reason, n]) => (
                      <span key={reason}>{`${reason} ×${n}`}</span>
                    ))}
                  </div>
                )}
                {detail.job.error && (
                  <div className="font-mono text-[11px] text-danger">{detail.job.error}</div>
                )}

                <StageBlock name="dossier" testId="stage-dossier" record={detail.stages?.dossier} />
                <StageBlock name="summary" testId="stage-summary" record={detail.stages?.summary} />
                <StageBlock
                  name="candidates"
                  testId="stage-candidates"
                  record={detail.stages?.candidates}
                />
                {materializeRecords.map((m, i) => (
                  <StageBlock
                    key={`${m.type}:${m.target}:${i}`}
                    name={`materialize · ${m.type} · ${m.target}`}
                    testId={`stage-materialize-${i}`}
                    record={m}
                  />
                ))}

                {detail.dropped.length > 0 && (
                  <div className="flex flex-col gap-1 border-t border-hair pt-2">
                    <div className="font-mono text-[11px] uppercase tracking-wide text-dim">
                      Dropped candidates
                    </div>
                    <table className="w-full font-mono text-[11px] text-ink">
                      <tbody>
                        {detail.dropped.map((x, i) => (
                          <tr key={`${x.type}:${x.target}:${i}`}>
                            <td className="pr-3 text-dim">{x.type}</td>
                            <td className="pr-3">{x.target}</td>
                            <td className="pr-3 truncate">{x.title}</td>
                            <td className="text-danger">{x.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {detail.stages?.dossierUncitedDropped && (
                  <div className="font-mono text-[11px] text-dim">
                    Uncited dossier items dropped:{' '}
                    {Object.entries(detail.stages.dossierUncitedDropped)
                      .map(([k, n]) => `${k} ×${n}`)
                      .join(', ')}
                  </div>
                )}

                {detail.stages?.candidatesMalformedDropped !== undefined && (
                  <div className="font-mono text-[11px] text-dim">
                    Malformed candidates dropped: {detail.stages.candidatesMalformedDropped}
                  </div>
                )}

                {detail.trajectory && (
                  <details className="border-t border-hair pt-2">
                    <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-wide text-dim">
                      Trajectory ({detail.trajectory.length} entries)
                    </summary>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-r4 bg-panel p-2 font-mono text-[11px] text-ink">
                      {JSON.stringify(detail.trajectory, null, 2)}
                    </pre>
                  </details>
                )}

                <div className="font-mono text-[11px] text-dim">
                  input snapshot: {detail.inputSnapshotChars} chars
                </div>
              </>
            )}
          </>
        )}
      </div>
    </ModalShell>
  )
}
