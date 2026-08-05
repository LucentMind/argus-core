import { useEffect, useRef, useState } from 'react'
import { History, Search } from 'lucide-react'
import type {
  RelatedFilters,
  RelatedHit,
  RelatedSearchInput,
  RelatedSearchMode,
  RelatedSearchResult,
  RelatedSourceInfo,
  SourceHealth
} from '../../../../shared/relatedHistory'
import { RELATED_SEARCH_MAX_LIMIT } from '../../../../shared/relatedHistory'
import { Btn, Chip } from '../ui'
import { ModalShell } from '../ModalShell'
import { blurOnEscape } from '../../lib/escapeLayer'
import { panelsStore } from '../../lib/panelsStore'
import { ExplorerFilters } from './ExplorerFilters'
import { HitDetail } from './HitDetail'

/** Per-provider page size. Raised, never offset — the contract has no cursor
 *  (spec §3.4) and 50 is the server-enforced ceiling on `limit`. */
export const EXPLORER_PAGE = 10

/** Everything that decides one request. Held as ONE state object so a filter
 *  change is a single transition the search effect reacts to, rather than N
 *  setters racing an effect that reads stale values. */
export interface ExplorerRequest {
  text: string
  /** True once the user typed in the box: the request stops being case-composed. */
  edited: boolean
  mode: RelatedSearchMode
  filters: RelatedFilters
  includeOpen: boolean
  /** Provider ids the user unchecked in the rail. */
  excluded: string[]
  limit: number
}

const INITIAL: ExplorerRequest = {
  text: '',
  edited: false,
  mode: 'hybrid',
  filters: {},
  includeOpen: false,
  excluded: [],
  limit: EXPLORER_PAGE
}

function toInput(
  req: ExplorerRequest,
  caseSlug: string | null,
  allProviderIds: string[]
): RelatedSearchInput {
  const input: RelatedSearchInput = { limit: req.limit }
  if (caseSlug) input.caseSlug = caseSlug
  // A case-scoped request sends no `query` until the box is edited — query
  // composition is main's job (relatedHistory/query.ts) and echoing the seeded
  // text back would fork it into a second, drifting copy.
  if (req.edited || !caseSlug) input.query = req.text
  if (req.mode !== 'hybrid') input.mode = req.mode
  if (Object.keys(req.filters).length > 0) input.filters = req.filters
  if (req.includeOpen) input.includeOpenCases = true
  if (req.excluded.length > 0) {
    input.providerIds = allProviderIds.filter((id) => !req.excluded.includes(id))
  }
  return input
}

function degradedLabel(sources: SourceHealth[]): string | null {
  const failed = sources.filter((s) => !s.ok)
  if (failed.length === 0) return null
  if (failed.length === 1) return `${failed[0].name} unavailable`
  return `${failed.length} sources unavailable`
}

function HitLine({
  hit,
  selected,
  onSelect
}: {
  hit: RelatedHit
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const label = hit.kind === 'corpus' ? `${hit.key} — ${hit.title}` : hit.title
  return (
    <button
      type="button"
      aria-current={selected}
      onClick={onSelect}
      className={`flex flex-col gap-1 rounded-r2 border p-2 text-left ${
        selected ? 'border-signal/40 bg-hair/50' : 'border-hair hover:bg-hair/30'
      }`}
    >
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-ink">{label}</span>
        {hit.provenance.map((p) => (
          <Chip key={p.providerId} tone={p.kind === 'local' ? 'neutral' : 'signal'}>
            {p.providerName}
          </Chip>
        ))}
        {(hit.matchedOn === 'semantic' || hit.matchedOn === 'both') && (
          <Chip tone="defect">semantic</Chip>
        )}
        <Chip
          tone={
            hit.status.tone === 'open'
              ? 'signal'
              : hit.status.tone === 'forwarded'
                ? 'review'
                : 'neutral'
          }
        >
          {hit.status.label}
        </Chip>
      </span>
      {hit.snippet && <span className="truncate text-[11px] text-dim">{hit.snippet}</span>}
    </button>
  )
}

/**
 * The related-history explorer (spec §8) — ONE component with two entry points.
 *
 * Case-scoped (`caseSlug` set): seeded from the case's composed query, and the
 * case itself is excluded from local results even after the box is edited.
 * Standalone (`caseSlug` null): free-form, no case binding.
 *
 * Increment 3 adds the pull-into-case actions; this increment renders none in
 * either mode.
 */
export function RelatedHistoryExplorer({
  caseSlug = null,
  onOpenCase
}: {
  caseSlug?: string | null
  onOpenCase?: (slug: string) => void
}): React.JSX.Element {
  const [req, setReq] = useState<ExplorerRequest>(INITIAL)
  const [draft, setDraft] = useState('')
  // Paired with the exact request that produced it (by reference) rather than
  // split into separate `result`/`loading` state: a fresh request's effect
  // would need `setLoading(true)` synchronously in its own body to flip the
  // flag before the response lands, which is exactly what
  // `react-hooks/set-state-in-effect` forbids. Comparing `completed?.req` to
  // the live `req` derives the same "in flight" signal for free, and the
  // previous result stays on screen (no flicker) until the new one arrives.
  const [completed, setCompleted] = useState<{
    req: ExplorerRequest
    result: RelatedSearchResult
  } | null>(null)
  const [sources, setSources] = useState<RelatedSourceInfo[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [probeNonce, setProbeNonce] = useState(0)
  const seeded = useRef(false)

  useEffect(() => {
    let alive = true
    void window.argus.related
      .sources()
      .then((s) => {
        if (alive) setSources(s)
      })
      .catch(() => {
        /* the rail simply shows no capability info; search still works */
      })
    return () => {
      alive = false
    }
  }, [probeNonce])

  // Standalone with an empty box: there is nothing to ask for. The service would
  // short-circuit anyway, but not calling keeps the empty state honest ("type
  // something") instead of "nothing matched".
  const shouldSearch = Boolean(caseSlug) || req.text.trim() !== ''

  useEffect(() => {
    if (!shouldSearch) return
    let alive = true
    const ids = sources.map((s) => s.id)
    void window.argus.related
      .search(toInput(req, caseSlug, ids))
      .then((r) => {
        if (!alive) return
        setCompleted({ req, result: r })
        // Echoed query seeds the box exactly once, so a user edit is never
        // overwritten by a later response.
        if (!seeded.current && !req.edited) {
          seeded.current = true
          setDraft(r.query)
        }
      })
      .catch(() => {
        /* the list simply keeps showing the last completed result */
      })
    return () => {
      alive = false
    }
    // `sources` is read for provider ids only; a probe landing later must not
    // re-fire the search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, caseSlug, shouldSearch])

  const shown = shouldSearch ? (completed?.result ?? null) : null
  const loading = shouldSearch && completed?.req !== req
  const hits = shown?.hits ?? []
  const degraded = shown ? degradedLabel(shown.sources) : null
  const active = hits.find((h) => h.id === selected) ?? null
  const canShowMore = hits.length >= req.limit && req.limit < RELATED_SEARCH_MAX_LIMIT

  return (
    <div className="flex min-h-0 flex-1 gap-3 p-3">
      <ExplorerFilters
        req={req}
        sources={sources}
        health={shown?.sources ?? []}
        onChange={(patch) => setReq((r) => ({ ...r, ...patch, limit: EXPLORER_PAGE }))}
        onRetry={() => {
          setProbeNonce((n) => n + 1)
          setReq((r) => ({ ...r }))
        }}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        <form
          role="search"
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            setReq((r) => ({ ...r, text: draft, edited: true, limit: EXPLORER_PAGE }))
          }}
        >
          <Search size={14} strokeWidth={1.5} className="text-mute" />
          <input
            aria-label="Search related history"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={blurOnEscape}
            placeholder="Search your cases and every configured corpus"
            className="min-w-0 flex-1 rounded-r2 border border-hair bg-overlay px-2 py-1 text-xs text-ink"
          />
          <Btn type="submit" variant="outline">
            Search
          </Btn>
        </form>
        {degraded && <div className="text-[11px] text-mute">{degraded}</div>}
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="flex min-h-0 w-1/2 flex-col gap-1.5 overflow-y-auto">
            {hits.map((h) => (
              <HitLine
                key={h.id}
                hit={h}
                selected={h.id === selected}
                onSelect={() => setSelected(h.id)}
              />
            ))}
            {!loading && hits.length === 0 && shown && (
              <p className="text-xs text-dim">No related history for this query.</p>
            )}
            {!shown && !caseSlug && (
              <p className="text-xs text-dim">
                Search your cases and every configured corpus to find history for a symptom, an
                error string or a ticket key.
              </p>
            )}
            {canShowMore && (
              <Btn
                variant="ghost"
                onClick={() =>
                  setReq((r) => ({
                    ...r,
                    limit: Math.min(r.limit + EXPLORER_PAGE, RELATED_SEARCH_MAX_LIMIT)
                  }))
                }
              >
                Show more
              </Btn>
            )}
          </div>
          <div className="min-h-0 w-1/2 overflow-y-auto border-l border-hair pl-3">
            {active ? (
              // key: HitDetail holds the followed-link key as instance state.
              // Without a remount per hit, selecting another row would keep
              // showing the previous row's linked ticket — and resetting it from
              // an effect trips `react-hooks/set-state-in-effect`, which is
              // enabled here and only fails after tests and typecheck are green.
              <HitDetail key={active.id} hit={active} onOpenCase={onOpenCase} />
            ) : (
              <p className="text-xs text-dim">Select a result to see the full record.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Case-scoped entry point: the explorer inside the shared modal chrome, with
 *  the native-panel occlusion registration every in-case modal needs. */
export function RelatedHistoryExplorerModal({
  caseSlug,
  onOpenCase,
  onClose
}: {
  caseSlug: string
  onOpenCase?: (slug: string) => void
  onClose: () => void
}): React.JSX.Element {
  useEffect(() => panelsStore.registerModal(`related-explorer:${caseSlug}`), [caseSlug])
  return (
    <ModalShell
      title={
        <>
          <History size={14} strokeWidth={1.5} />
          Related history
        </>
      }
      ariaLabel="Related history explorer"
      onClose={onClose}
      variant="reading"
      className="h-[80vh] w-[85vw] max-w-6xl"
    >
      <RelatedHistoryExplorer caseSlug={caseSlug} onOpenCase={onOpenCase} />
    </ModalShell>
  )
}
