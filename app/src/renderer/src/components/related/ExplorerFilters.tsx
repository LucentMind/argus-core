import { useRef, useState } from 'react'
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

type TokenFilterKey = (typeof TOKEN_FILTERS)[number]['key']

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

/** One row in the rail's union of the standing probe and the last search's
 *  per-provider health, keyed by id — see `railRows`. A row with no `source`
 *  came from health alone (a provider the probe doesn't list, e.g. local
 *  before `includeOpenCases` was ever set) and shows only a name and status,
 *  never capability info it was never given. */
interface RailRow {
  id: string
  name: string
  source: RelatedSourceInfo | undefined
  health: SourceHealth | undefined
}

/** Union of `sources` (the standing probe) and `health` (the last search's
 *  per-provider outcome), keyed by id. A provider missing from the probe but
 *  present in `health` is exactly the case `sources()` cannot see (spec: it
 *  takes no per-call options, so it mirrors only the DEFAULT fan-out gate) —
 *  without this union that provider's row, and its checkbox, would simply
 *  never exist, so unchecking "everything visible" would silently leave it
 *  included in the fan-out. */
function railRows(sources: RelatedSourceInfo[], health: SourceHealth[]): RailRow[] {
  const rows = new Map<string, RailRow>()
  for (const s of sources) rows.set(s.id, { id: s.id, name: s.name, source: s, health: undefined })
  for (const h of health) {
    const existing = rows.get(h.id)
    if (existing) existing.health = h
    else rows.set(h.id, { id: h.id, name: h.name, source: undefined, health: h })
  }
  return [...rows.values()]
}

/** One line per source: whether to search it, plus why it is not answering. */
function SourceRow({
  name,
  source,
  health,
  checked,
  onToggle,
  onRetry
}: {
  name: string
  source: RelatedSourceInfo | undefined
  health: SourceHealth | undefined
  checked: boolean
  onToggle: () => void
  onRetry: () => void
}): React.JSX.Element {
  // Search health (this request's outcome) wins over the standing probe: a
  // source that answered a moment ago but failed THIS search is the state the
  // user is looking at. A health-only row (no probe entry at all) has nothing
  // to fall back to and is simply never in error from the probe's side.
  const error = health
    ? health.ok
      ? undefined
      : health.error
    : source && !source.ok
      ? source.error
      : undefined
  return (
    <div className="flex flex-col gap-0.5">
      <Toggle checked={checked} onChange={onToggle} aria-label={`Search ${name}`} label={name} />
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
  probed,
  onChange,
  onRetry
}: {
  req: ExplorerRequest
  sources: RelatedSourceInfo[]
  health: SourceHealth[]
  /** Whether the standing probe (`related:sources`) has ever resolved. A
   *  pending or permanently-rejected probe is not evidence that no sources
   *  exist, so the empty-rail copy below must not show until this is true. */
  probed: boolean
  onChange: (patch: Partial<ExplorerRequest>) => void
  onRetry: () => void
}): React.JSX.Element {
  const semanticAvailable = sources.some((s) => s.semantic)
  const projects = [...new Set(sources.flatMap((s) => s.projects))].sort()
  const rows = railRows(sources, health)

  // Important 3: the four token boxes below fire `onChange` — a fresh `req`,
  // and so a fresh network fan-out to every configured corpus — only on blur
  // or Enter, never on every keystroke. `drafts` holds the in-progress text
  // for a box the user is actively typing in; it is controlled (falls back to
  // `req.filters[key]` once there is no draft), unlike the old `defaultValue`
  // input, which stopped reflecting `req.filters` the moment the user touched
  // it.
  const [drafts, setDrafts] = useState<Partial<Record<TokenFilterKey, string>>>({})
  // A box a user Escaped out of must not also commit: `blurOnEscape` (used by
  // every other field) just calls `.blur()`, and this box commits on blur —
  // so an Escape-triggered blur would fire `commitToken` with the abandoned
  // draft text unless something stops it. `drafts` itself can't carry that
  // signal: `.blur()` fires the `blur` event, and so `onBlur`, SYNCHRONOUSLY
  // within the same keydown handler, before React has re-rendered with the
  // draft cleared — so `onBlur`'s closure would still see the stale `drafts`
  // that still contains the key. A ref sidesteps that: writes are visible
  // immediately, with no render in between, to any closure holding the same
  // ref object.
  const skipCommitRef = useRef<Set<TokenFilterKey>>(new Set())

  // Guards on "is there actually an uncommitted draft for this key" so that
  // focusing a box and leaving it untouched — no keystroke, ever — cannot
  // fire `onChange`: without this, EVERY blur (including a bare focus+blur)
  // re-sent `filters` as a fresh object, which is a fresh `req` identity and
  // so a full IPC fan-out to every configured corpus, plus a paging reset.
  // It also caps Enter-then-blur at exactly one `onChange`: Enter's own
  // `commitToken` call already clears the draft, so the blur that follows
  // finds no draft left to commit.
  function commitToken(key: TokenFilterKey, raw: string): void {
    if (skipCommitRef.current.delete(key)) return
    if (!(key in drafts)) return
    const tokens = parseTokens(raw)
    const committed = req.filters[key] ?? []
    // Minor 2: a draft existing is not the same as the draft having CHANGED
    // anything. Retyping the exact committed text, or typing then deleting
    // back to it, still leaves an entry in `drafts` — the guard above only
    // tests draft existence. Without comparing against what is actually
    // committed, either still manufactures a fresh `filters` object, and so
    // a fresh `req` identity: a full IPC fan-out to every configured corpus
    // plus a paging reset, for an edit that never happened.
    const unchanged =
      tokens.length === committed.length && tokens.every((t, i) => t === committed[i])
    if (!unchanged) {
      onChange({ filters: setList(req.filters, key, tokens) })
    }
    setDrafts((d) => {
      if (!(key in d)) return d
      const next = { ...d }
      delete next[key]
      return next
    })
  }

  return (
    <aside className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto pr-2">
      <div className="flex flex-col gap-1.5">
        <SectionLabel>Sources</SectionLabel>
        {rows.length === 0 && probed && (
          <p className="text-[11px] text-dim">
            No searchable sources. Add a defect corpus in Settings → Defect corpus, or close and
            distill a case.
          </p>
        )}
        {rows.map((row) => (
          <SourceRow
            key={row.id}
            name={row.name}
            source={row.source}
            health={row.health}
            checked={!req.excluded.includes(row.id)}
            onToggle={() =>
              onChange({
                excluded: req.excluded.includes(row.id)
                  ? req.excluded.filter((id) => id !== row.id)
                  : [...req.excluded, row.id]
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
              value={drafts[key] ?? (req.filters[key] ?? []).join(', ')}
              onChange={(e) => {
                const raw = e.target.value
                // Minor 1: `skipCommitRef` is normally consumed (and so
                // cleared) by `commitToken`'s own `.delete()` the moment the
                // Escape-triggered blur fires. But on any path where
                // `.blur()` dispatches nothing — the element was not
                // actually focused, among other cases — `commitToken` is
                // never reached, so the key stays in the Set forever and
                // silently eats the NEXT genuine commit for it. A fresh
                // keystroke is unambiguous proof the user is editing again,
                // not discarding, so clear the flag here too: it can never
                // outlive the draft it was meant to suppress.
                skipCommitRef.current.delete(key)
                setDrafts((d) => ({ ...d, [key]: raw }))
              }}
              onBlur={(e) => commitToken(key, e.target.value)}
              onKeyDown={(e) => {
                // The house `blurOnEscape` convention just blurs, which for
                // every OTHER field is enough (there is no pending draft to
                // lose). Here Escape must DISCARD the draft, not commit it —
                // so the draft is cleared and `commitToken` is told to skip
                // BEFORE `.blur()` synchronously fires `onBlur`.
                if (e.key === 'Escape') {
                  skipCommitRef.current.add(key)
                  setDrafts((d) => {
                    if (!(key in d)) return d
                    const next = { ...d }
                    delete next[key]
                    return next
                  })
                  e.currentTarget.blur()
                  return
                }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitToken(key, e.currentTarget.value)
                }
              }}
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
