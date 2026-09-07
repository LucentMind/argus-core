import { Loader2, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import type { DistillProgress, DistillRunListRow } from '../../../../shared/distill'
import { IconBtn } from '../ui'
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
  header,
  width,
  collapsed = false,
  onCollapsedChange
}: {
  rows: DistillRunListRow[]
  progress: ReadonlyMap<number, DistillProgress>
  filters: RunFilters
  onFilters: (f: RunFilters) => void
  selectedId: number | null
  onSelect: (id: number) => void
  /** The "New run…" control, owned by the view. */
  header?: React.ReactNode
  /** Persisted rail width in px, from `uiStore`. The view owns the drag; this owns the box. */
  width: number
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}): React.JSX.Element {
  const toggle = (group: keyof Omit<RunFilters, 'search'>, value: string): void => {
    const next = new Set(filters[group] as ReadonlySet<string>)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    onFilters({ ...filters, [group]: next } as RunFilters)
  }

  // Collapsed is a strip, not `display: none`: a rail that vanishes with no affordance left
  // behind is a rail the user cannot get back without knowing a keyboard shortcut that does
  // not exist. The strip keeps the run count visible so the view still says how much is here.
  if (collapsed)
    return (
      <aside className="flex shrink-0 flex-col items-center gap-2 border-r border-hair pr-2">
        <IconBtn
          size="sm"
          aria-label="Show runs"
          title="Show runs"
          onClick={() => onCollapsedChange?.(false)}
        >
          <PanelLeftOpen size={14} />
        </IconBtn>
        <span
          className="select-none font-mono text-[10px] tracking-widest text-mute"
          style={{ writingMode: 'vertical-rl' }}
        >
          {rows.length} runs
        </span>
      </aside>
    )

  const groups = groupByCase(applyFilters(rows, filters))
  return (
    <aside
      className="flex shrink-0 flex-col gap-2 border-r border-hair pr-3"
      style={{ width, minWidth: width }}
    >
      <div className="flex items-center gap-2">
        <IconBtn
          size="sm"
          aria-label="Hide runs"
          title="Hide runs"
          onClick={() => onCollapsedChange?.(true)}
        >
          <PanelLeftClose size={14} />
        </IconBtn>
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
              // A resting hairline, not a bare word: these read as inert labels otherwise, and
              // there is nothing else in the row to tell a reader they can be pressed.
              className={`rounded-r1 border px-2 py-0.5 font-mono text-[10.5px] transition-colors ${
                on
                  ? 'border-hair2 bg-hi text-ink'
                  : 'border-hair text-dim hover:border-hair2 hover:bg-hair hover:text-ink'
              }`}
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
