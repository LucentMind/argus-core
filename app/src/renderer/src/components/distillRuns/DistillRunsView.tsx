import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import type {
  DistillProgress,
  DistillRunDetail,
  DistillRunListRow
} from '../../../../shared/distill'
import { IconBtn, SkeletonRows } from '../ui'
import { useEscapeLayer } from '../../lib/escapeLayer'
import { viewTitleStore } from '../../lib/viewTitleStore'
import { RunsRail } from './RunsRail'
import { RunDetail } from './RunDetail'
import { NewRunPopover } from './NewRunPopover'
import { EMPTY_FILTERS, type RunFilters } from './runsModel'

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

/** Dev-only top-level view — same standing as ProposalsStandalone. Rail of every case job, one
 *  selected run rendered structured, an optional second run of the same case beside it. */
export function DistillRunsView({
  initialSlug,
  onClose,
  onOpenCase
}: {
  initialSlug?: string
  onClose: () => void
  onOpenCase: (slug: string) => void
}): React.JSX.Element {
  const [rows, setRows] = useState<DistillRunListRow[] | null>(null)
  const [filters, setFilters] = useState<RunFilters>({
    ...EMPTY_FILTERS,
    search: initialSlug ?? ''
  })
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [compareId, setCompareId] = useState<number | null>(null)
  const [detail, setDetail] = useState<DistillRunDetail | null>(null)
  const [compareDetail, setCompareDetail] = useState<DistillRunDetail | null>(null)
  const [progress, setProgress] = useState<ReadonlyMap<number, DistillProgress>>(new Map())
  const [refetchTick, setRefetchTick] = useState(0)
  const [newRun, setNewRun] = useState<{ fixedSlug?: string } | null>(null)
  const [cancelling, setCancelling] = useState(false)

  useEscapeLayer({ onEscape: onClose })
  // Two effects rather than one with a cleanup keyed on `rows` (ProposalsStandalone's pattern):
  // a single effect there would publish null on every rows change before republishing, flickering
  // the header title on each refetch. The cleanup-only effect (empty deps) publishes null exactly
  // once, on unmount.
  useEffect(() => {
    viewTitleStore.publish({
      label: 'Distillation runs',
      detail: rows ? `· ${rows.length} runs` : undefined
    })
  }, [rows])
  useEffect(() => () => viewTitleStore.publish(null), [])

  // List: on mount and on every distill:changed broadcast (a new row, or a state flip).
  useEffect(() => {
    let live = true
    void window.argus.distill
      .runsAll()
      .then((rs) => {
        if (!live) return
        setRows(rs)
        setProgress((prev) => {
          const next = new Map(prev)
          for (const r of rs) if (r.progress) next.set(r.id, r.progress)
          return next
        })
        setSelectedId((cur) => {
          if (cur !== null && rs.some((r) => r.id === cur)) return cur
          const pool = initialSlug ? rs.filter((r) => r.caseSlug === initialSlug) : rs
          return pool[0]?.id ?? rs[0]?.id ?? null
        })
      })
      .catch(() => live && setRows([]))
    return () => {
      live = false
    }
  }, [initialSlug, refetchTick])

  useEffect(
    () =>
      window.argus.distill.onChanged((p) => {
        if (p.job && TERMINAL.has(p.job.state))
          setProgress((prev) => {
            const n = new Map(prev)
            n.delete(p.job!.id)
            return n
          })
        setRefetchTick((t) => t + 1)
      }),
    []
  )
  useEffect(
    () =>
      window.argus.distill.onProgress((p) => setProgress((prev) => new Map(prev).set(p.jobId, p))),
    []
  )

  // Detail for the selected run; refetched with the list so a terminal flip lands here too.
  useEffect(() => {
    if (selectedId === null) return
    let live = true
    void window.argus.distill
      .run(selectedId)
      .then((d) => live && setDetail(d))
      .catch(() => live && setDetail(null))
    return () => {
      live = false
    }
  }, [selectedId, refetchTick])
  useEffect(() => {
    if (compareId === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCompareDetail(null)
      return
    }
    let live = true
    void window.argus.distill
      .run(compareId)
      .then((d) => live && setCompareDetail(d))
      .catch(() => live && setCompareDetail(null))
    return () => {
      live = false
    }
  }, [compareId, refetchTick])

  const selectedRow = rows?.find((r) => r.id === selectedId) ?? null
  const siblings = useMemo(
    () =>
      (rows ?? []).filter(
        (r) => selectedRow && r.caseSlug === selectedRow.caseSlug && r.id !== selectedRow.id
      ),
    [rows, selectedRow]
  )
  const inFlightSlugs = useMemo(
    () =>
      new Set(
        (rows ?? [])
          .filter((r) => r.state === 'queued' || r.state === 'running')
          .map((r) => r.caseSlug)
      ),
    [rows]
  )
  const select = (id: number): void => {
    setSelectedId(id)
    setCompareId(null)
  }
  const cancelSelected = (): void => {
    if (cancelling || !selectedRow) return
    setCancelling(true)
    void window.argus.distill.cancel(selectedRow.id).finally(() => setCancelling(false))
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-[1600px] gap-4 p-6">
      {rows === null ? (
        <SkeletonRows count={6} />
      ) : (
        <RunsRail
          rows={rows}
          progress={progress}
          filters={filters}
          onFilters={setFilters}
          selectedId={selectedId}
          onSelect={select}
          header={
            <button
              type="button"
              className="rounded-r1 bg-hi px-2 py-1 text-xs text-ink"
              onClick={() => setNewRun({})}
            >
              New run…
            </button>
          }
        />
      )}
      <main className="relative flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-ink">
            Distillation runs{' '}
            <span className="rounded-r1 bg-hair px-1.5 font-mono text-[10px] text-dim">dev</span>
          </h1>
          <IconBtn aria-label="Close" title="Close" onClick={onClose}>
            <X size={14} />
          </IconBtn>
        </div>
        {rows && rows.length === 0 && (
          <div className="py-16 text-center font-mono text-xs text-dim">
            No distillation has run yet.
          </div>
        )}
        {detail && selectedRow && (
          <div
            data-testid={compareDetail ? 'compare-columns' : 'single-column'}
            className={compareDetail ? 'grid grid-cols-2 gap-4' : ''}
          >
            <RunDetail
              detail={detail}
              progress={progress.get(detail.job.id) ?? null}
              compact={Boolean(compareDetail)}
              actions={
                <>
                  <button
                    type="button"
                    className="rounded-r1 px-2 py-0.5 text-dim hover:bg-hair"
                    onClick={() => onOpenCase(selectedRow.caseSlug)}
                  >
                    Open case
                  </button>
                  <button
                    type="button"
                    className="rounded-r1 px-2 py-0.5 text-dim hover:bg-hair disabled:opacity-40"
                    disabled={inFlightSlugs.has(selectedRow.caseSlug)}
                    title={
                      inFlightSlugs.has(selectedRow.caseSlug)
                        ? 'A distillation is already running for this case'
                        : undefined
                    }
                    onClick={() => setNewRun({ fixedSlug: selectedRow.caseSlug })}
                  >
                    Run again
                  </button>
                  {(selectedRow.state === 'queued' || selectedRow.state === 'running') && (
                    <button
                      type="button"
                      className="rounded-r1 px-2 py-0.5 text-dim hover:bg-hair disabled:opacity-40"
                      disabled={cancelling}
                      onClick={cancelSelected}
                    >
                      Cancel
                    </button>
                  )}
                  <label className="flex items-center gap-1 text-dim">
                    Compare with
                    <select
                      aria-label="Compare with"
                      value={compareId ?? ''}
                      onChange={(e) => setCompareId(e.target.value ? Number(e.target.value) : null)}
                      className="rounded-r1 border border-hair bg-overlay px-1 py-0.5 text-xs text-ink"
                    >
                      <option value="">—</option>
                      {siblings.map((r) => (
                        <option key={r.id} value={r.id}>
                          #{r.id} · {r.pipeline ?? '?'}
                          {r.dryRun ? ' · dry' : ''} · {r.state}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              }
            />
            {compareDetail && (
              <RunDetail
                detail={compareDetail}
                progress={progress.get(compareDetail.job.id) ?? null}
                compact
              />
            )}
          </div>
        )}
        {newRun && (
          <div className="absolute right-6 top-16 z-20">
            <NewRunPopover
              fixedSlug={newRun.fixedSlug}
              inFlightSlugs={inFlightSlugs}
              onStarted={(job) => {
                setSelectedId(job.id)
                setCompareId(null)
                // The list state won't otherwise include the new job until the main process's
                // `distill:changed` broadcast lands; bump the same tick that broadcast drives so
                // the rail and the freshly-selected run's detail both refetch right away.
                setRefetchTick((t) => t + 1)
              }}
              onClose={() => setNewRun(null)}
            />
          </div>
        )}
      </main>
    </div>
  )
}
