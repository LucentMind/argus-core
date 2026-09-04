import { Loader2 } from 'lucide-react'
import type { DistillProgress, DistillRunListRow } from '../../../../shared/distill'
import { applyFilters, groupByCase, phaseLine, runRowLabel, type RunFilters } from './runsModel'

const CHIPS: { group: keyof Omit<RunFilters, 'search'>; value: string; label: string }[] = [
  { group: 'pipeline', value: 'v2', label: 'v2' },
  { group: 'pipeline', value: 'v3', label: 'v3' },
  { group: 'mode', value: 'dry', label: 'dry' },
  { group: 'mode', value: 'real', label: 'real' },
  { group: 'outcome', value: 'failed', label: 'failed' },
  { group: 'outcome', value: 'zero', label: '0 staged' },
  { group: 'outcome', value: 'running', label: 'running' }
]

export function RunsRail({
  rows,
  progress,
  filters,
  onFilters,
  selectedId,
  onSelect,
  header
}: {
  rows: DistillRunListRow[]
  progress: ReadonlyMap<number, DistillProgress>
  filters: RunFilters
  onFilters: (f: RunFilters) => void
  selectedId: number | null
  onSelect: (id: number) => void
  /** The "New run…" control, owned by the view. */
  header?: React.ReactNode
}): React.JSX.Element {
  const toggle = (group: keyof Omit<RunFilters, 'search'>, value: string): void => {
    const next = new Set(filters[group] as ReadonlySet<string>)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    onFilters({ ...filters, [group]: next } as RunFilters)
  }
  const groups = groupByCase(applyFilters(rows, filters))
  return (
    <aside className="flex w-[34%] min-w-[260px] flex-col gap-2 border-r border-hair pr-3">
      <div className="flex items-center gap-2">
        <input
          type="search"
          aria-label="Search cases"
          placeholder="case, title or key"
          value={filters.search}
          onChange={(e) => onFilters({ ...filters, search: e.target.value })}
          className="min-w-0 flex-1 rounded-r1 border border-hair bg-well px-2 py-1 text-xs text-ink"
        />
        {header}
      </div>
      <div className="flex flex-wrap gap-1">
        {CHIPS.map((c) => {
          const on = (filters[c.group] as ReadonlySet<string>).has(c.value)
          return (
            <button
              key={`${c.group}:${c.value}`}
              type="button"
              aria-label={`Filter ${c.label}`}
              aria-pressed={on}
              onClick={() => toggle(c.group, c.value)}
              className={`rounded-r1 px-2 py-0.5 font-mono text-[10.5px] ${on ? 'bg-hi text-ink' : 'text-dim hover:bg-hair'}`}
            >
              {c.label}
            </button>
          )
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 && (
          <div className="py-8 text-center font-mono text-xs text-dim">No runs match.</div>
        )}
        {groups.map((g) => (
          <div key={g.slug} data-testid="case-group" className="mb-2">
            <div className="flex items-baseline gap-2 px-1 py-1 text-xs">
              <span className="truncate text-ink">{g.title}</span>
              {g.jiraKey && <span className="font-mono text-dim">{g.jiraKey}</span>}
              <span className="ml-auto font-mono text-[10px] text-mute">{g.runs.length}</span>
            </div>
            {g.runs.map((r) => {
              const p = progress.get(r.id)
              const live = r.state === 'queued' || r.state === 'running'
              return (
                <button
                  key={r.id}
                  type="button"
                  data-testid="run-row"
                  aria-current={r.id === selectedId ? 'true' : undefined}
                  onClick={() => onSelect(r.id)}
                  className={`block w-full truncate rounded-r1 px-2 py-1 text-left font-mono text-[11px] ${r.id === selectedId ? 'bg-hi text-ink' : 'text-dim hover:bg-hair'}`}
                >
                  {live ? (
                    <>
                      <Loader2 size={11} className="inline animate-spin" aria-hidden="true" />{' '}
                      {`#${r.id} · ${r.pipeline ?? '?'}${r.dryRun ? ' · dry' : ''} · ${p ? phaseLine(p) : r.state}`}
                    </>
                  ) : (
                    runRowLabel(r)
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </aside>
  )
}
