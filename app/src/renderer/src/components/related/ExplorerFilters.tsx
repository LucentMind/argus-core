import type {
  RelatedFilters,
  RelatedSearchMode,
  RelatedSourceInfo,
  SourceHealth
} from '../../../../shared/relatedHistory'
import { Btn, SectionLabel, Toggle } from '../ui'
import { blurOnEscape } from '../../lib/escapeLayer'
import type { ExplorerRequest } from './RelatedHistoryExplorer'

const MODES: Array<{ id: RelatedSearchMode; label: string }> = [
  { id: 'hybrid', label: 'Hybrid' },
  { id: 'lexical', label: 'Lexical' },
  { id: 'semantic', label: 'Semantic' }
]

/** The four facets the contract does NOT enumerate anywhere (§4.2 accepts them;
 *  no endpoint lists their values), so they are token inputs rather than
 *  dropdowns. Deriving options from the current result set would state a fact
 *  about the corpus that we have not been told. */
const TOKEN_FILTERS = [
  { key: 'components', label: 'Components' },
  { key: 'resolutions', label: 'Resolutions' },
  { key: 'statuses', label: 'Statuses' },
  { key: 'fixVersions', label: 'Fix versions' }
] as const

function setList(
  filters: RelatedFilters,
  key: keyof RelatedFilters,
  values: string[]
): RelatedFilters {
  const next = { ...filters }
  // Absent, never `[]`: an empty array is a filter that matches nothing, which
  // is not what "I cleared the box" means.
  if (values.length === 0) delete next[key]
  else Object.assign(next, { [key]: values })
  return next
}

function parseTokens(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

/** One line per source: whether to search it, plus why it is not answering. */
function SourceRow({
  source,
  health,
  checked,
  onToggle,
  onRetry
}: {
  source: RelatedSourceInfo
  health: SourceHealth | undefined
  checked: boolean
  onToggle: () => void
  onRetry: () => void
}): React.JSX.Element {
  // Search health (this request's outcome) wins over the standing probe: a
  // source that answered a moment ago but failed THIS search is the state the
  // user is looking at.
  const error = health && !health.ok ? health.error : !source.ok ? source.error : undefined
  return (
    <div className="flex flex-col gap-0.5">
      <Toggle
        checked={checked}
        onChange={onToggle}
        aria-label={`Search ${source.name}`}
        label={source.name}
      />
      {error && (
        <div className="ml-5 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[11px] text-danger" title={error}>
            {error}
          </span>
          <Btn variant="ghost" onClick={onRetry}>
            Retry
          </Btn>
        </div>
      )}
    </div>
  )
}

/**
 * The filter rail (spec §8) — and the surface a user goes to in order to find
 * out WHY results look thin: every configured source is listed with its own
 * status and a retry, healthy ones included.
 *
 * Each control states its scope, because no filter applies to both provider
 * kinds: the corpus facets are meaningless to `case_summaries`, and open-case
 * inclusion is meaningless to a tracker corpus. Marking them beats letting a
 * corpus-only filter look broken against local results.
 */
export function ExplorerFilters({
  req,
  sources,
  health,
  onChange,
  onRetry
}: {
  req: ExplorerRequest
  sources: RelatedSourceInfo[]
  health: SourceHealth[]
  onChange: (patch: Partial<ExplorerRequest>) => void
  onRetry: () => void
}): React.JSX.Element {
  const semanticAvailable = sources.some((s) => s.semantic)
  const projects = [...new Set(sources.flatMap((s) => s.projects))].sort()

  return (
    <aside className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto pr-2">
      <div className="flex flex-col gap-1.5">
        <SectionLabel>Sources</SectionLabel>
        {sources.length === 0 && (
          <p className="text-[11px] text-dim">
            No searchable sources. Add a defect corpus in Settings → Defect corpus, or close and
            distill a case.
          </p>
        )}
        {sources.map((s) => (
          <SourceRow
            key={s.id}
            source={s}
            health={health.find((h) => h.id === s.id)}
            checked={!req.excluded.includes(s.id)}
            onToggle={() =>
              onChange({
                excluded: req.excluded.includes(s.id)
                  ? req.excluded.filter((id) => id !== s.id)
                  : [...req.excluded, s.id]
              })
            }
            onRetry={onRetry}
          />
        ))}
      </div>

      {semanticAvailable && (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>Retrieval</SectionLabel>
          <div className="flex gap-1">
            {MODES.map((m) => (
              <Btn
                key={m.id}
                variant={req.mode === m.id ? 'primary' : 'ghost'}
                onClick={() => onChange({ mode: m.id })}
              >
                {m.label}
              </Btn>
            ))}
          </div>
          <p className="text-[10.5px] text-mute">Corpus sources only — your cases are lexical.</p>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <SectionLabel>Your cases</SectionLabel>
        <Toggle
          checked={req.includeOpen}
          onChange={() => onChange({ includeOpen: !req.includeOpen })}
          aria-label="Include open cases"
          label="Include open cases"
        />
        <p className="text-[10.5px] text-mute">Local only.</p>
      </div>

      {projects.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>Projects</SectionLabel>
          {projects.map((p) => {
            const on = req.filters.projects?.includes(p) ?? false
            return (
              <Toggle
                key={p}
                checked={on}
                aria-label={`Project ${p}`}
                label={p}
                onChange={() =>
                  onChange({
                    filters: setList(
                      req.filters,
                      'projects',
                      on
                        ? (req.filters.projects ?? []).filter((x) => x !== p)
                        : [...(req.filters.projects ?? []), p]
                    )
                  })
                }
              />
            )
          })}
          <p className="text-[10.5px] text-mute">Corpus only.</p>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <SectionLabel>Corpus filters</SectionLabel>
        {TOKEN_FILTERS.map(({ key, label }) => (
          <label key={key} className="flex flex-col gap-0.5 text-[11px] text-dim">
            {label}
            <input
              aria-label={label}
              defaultValue={(req.filters[key] ?? []).join(', ')}
              onChange={(e) =>
                onChange({ filters: setList(req.filters, key, parseTokens(e.target.value)) })
              }
              onKeyDown={blurOnEscape}
              placeholder="comma separated"
              className="rounded-r2 border border-hair bg-overlay px-1.5 py-1 text-xs text-ink"
            />
          </label>
        ))}
        <label className="flex flex-col gap-0.5 text-[11px] text-dim">
          Updated after
          <input
            type="date"
            aria-label="Updated after"
            value={req.filters.updatedAfter?.slice(0, 10) ?? ''}
            onChange={(e) => {
              const next = { ...req.filters }
              if (e.target.value === '') delete next.updatedAfter
              else next.updatedAfter = new Date(`${e.target.value}T00:00:00.000Z`).toISOString()
              onChange({ filters: next })
            }}
            onKeyDown={blurOnEscape}
            className="rounded-r2 border border-hair bg-overlay px-1.5 py-1 text-xs text-ink"
          />
        </label>
        <p className="text-[10.5px] text-mute">Corpus only.</p>
      </div>
    </aside>
  )
}
