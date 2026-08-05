import { useEffect, useRef, useState } from 'react'
import { History, Search, X } from 'lucide-react'
import type {
  RelatedFilters,
  RelatedHit,
  RelatedReason,
  RelatedSearchInput,
  RelatedSearchMode,
  RelatedSearchResult,
  RelatedSourceInfo,
  SourceHealth
} from '../../../../shared/relatedHistory'
import { RELATED_SEARCH_MAX_LIMIT } from '../../../../shared/relatedHistory'
import { Btn, Chip, IconBtn } from '../ui'
import { ModalShell } from '../ModalShell'
import { blurOnEscape, useEscapeLayer } from '../../lib/escapeLayer'
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

/** Sticky by-id merge: every id ever seen in `known` stays, updated in place
 *  with the freshest record for ids that reappear in `fresh`; ids `fresh`
 *  drops (e.g. a provider `search` no longer reports health for because the
 *  user's own `providerIds` filter excluded it this round, or a probe that no
 *  longer lists something a prior probe did) are left exactly as they were.
 *  This is what makes the rail (and
 *  `allProviderIds` below) survive a provider vanishing from a single round —
 *  see the rail-row-disappears fix. Returns `known` unchanged (same
 *  reference) when there is nothing new to fold in, so callers that only
 *  merge non-empty results (both call sites below) don't force an extra
 *  render. */
function mergeById<T extends { id: string }>(known: T[], fresh: T[]): T[] {
  if (fresh.length === 0) return known
  const byId = new Map(known.map((k) => [k.id, k]))
  for (const item of fresh) byId.set(item.id, item)
  return [...byId.values()]
}

/** Union of the standing probe and the last search's per-provider health, by
 *  id. Both arguments are expected to already be the STICKY, accumulated
 *  views (`mergeById`-maintained state), not a single round's raw response —
 *  `sources()` mirrors only the DEFAULT fan-out gate (no per-call options),
 *  so a provider that only becomes searchable under a non-default option
 *  (e.g. local once `includeOpenCases` is set) can be absent from the probe
 *  while still appearing in a completed search's health, and a LATER search
 *  can legitimately omit a provider's health entirely once it is excluded.
 *  Using non-sticky snapshots here would let a provider be silently and
 *  permanently dropped from `providerIds` filtering the moment it stops
 *  appearing in either source for even one round. */
function unionProviderIds(sources: RelatedSourceInfo[], health: SourceHealth[]): string[] {
  return [...new Set([...sources.map((s) => s.id), ...health.map((h) => h.id)])]
}

/** Important 1 (second wave): `mergeById` above is deliberately
 *  never-shrinking — that is what keeps a provider's row alive across a
 *  round that had no way to speak to it at all (excluded, or a probe that
 *  under-reports). But "never shrinks" is only correct under that
 *  condition. When a round DID have the chance to report an id — the
 *  request's own `providerIds` was either absent (asked for everything) or
 *  named it explicitly — and the response still omitted it, that omission
 *  is real, not a gap: the id is pinned by a stale entry (the synthetic
 *  `related-history` service failure, a provider that dropped out of the
 *  fan-out, a corpus removed from settings) and must clear. An id the user
 *  EXCLUDED is never in `providerIds`, so this never touches it — that is
 *  what keeps an unchecked row re-checkable, which the previous wave's
 *  stickiness fix depends on and which the tests below guard. */
function evictStale<T extends { id: string }>(
  known: T[],
  requestedIds: string[] | undefined,
  reportedIds: Set<string>
): T[] {
  const next = known.filter(
    (k) => reportedIds.has(k.id) || !(requestedIds === undefined || requestedIds.includes(k.id))
  )
  return next.length === known.length ? known : next
}

/** Minor 1: `no-providers` and `query-too-generic` both used to render the
 *  same "nothing matched" line. That reads as "your search found nothing"
 *  when the truth for `no-providers` is "you have not asked anything" — a
 *  state a user can now genuinely reach just by unchecking every rail row
 *  (Important 1 made an empty `providerIds` mean "nothing", not
 *  "everything"), so conflating the two is actively misleading.
 *
 *  Minor 3 (second wave): `no-providers` alone still conflated two distinct
 *  situations — nothing configured at all vs. every configured source
 *  unchecked — and the fresh-install case actively contradicted the rail,
 *  which (correctly) says "No searchable sources" in that state. Threading
 *  through whether any provider id is known at all (the same union the rail
 *  itself uses to decide that) lets the copy agree with the rail instead of
 *  telling the user to do something the rail says is impossible. */
function emptyResultLabel(reason: RelatedReason | undefined, hasKnownSources: boolean): string {
  if (reason === 'no-providers') {
    return hasKnownSources
      ? 'No sources are selected. Check a source in the rail to search it.'
      : 'No sources are configured. Add a defect corpus in Settings → Defect corpus, or close and distill a case.'
  }
  if (reason === 'query-too-generic') {
    return 'That search is too generic to match anything meaningful. Try a more specific term.'
  }
  return 'No related history for this query.'
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
 * Case-scoped renders the pull-into-case actions (spec §10); standalone renders
 * none, because there is no case to pull into.
 */
export function RelatedHistoryExplorer({
  caseSlug = null,
  sessionId = null,
  onOpenCase,
  onReferenced
}: {
  caseSlug?: string | null
  /** The case's active chat, for the "Reference in chat" action. Meaningless
   *  without `caseSlug`, and ignored when it is null. */
  sessionId?: number | null
  onOpenCase?: (slug: string) => void
  /** Fired after a citation is staged — the modal entry point closes on it so
   *  the composer it just filled is actually visible. */
  onReferenced?: () => void
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
  // Same req-identity pairing as `completed`, so a failed request stops being
  // "in flight" without a synchronous setState in the effect body, and a fresh
  // submission (a new `req` reference, even with identical fields — see the
  // Search-button handler) naturally clears a stale error off the screen.
  const [failed, setFailed] = useState<{ req: ExplorerRequest; message: string } | null>(null)
  // Both `sources` (the standing probe) and `health` (per-provider search
  // outcomes) are STICKY, `mergeById`-accumulated state — never a bare
  // snapshot of the latest round. See Important 1: a provider that survived
  // only a single round in either one must not vanish from the rail, nor
  // from `allProviderIds`, the moment a later round omits it.
  const [sources, setSources] = useState<RelatedSourceInfo[]>([])
  const [health, setHealth] = useState<SourceHealth[]>([])
  // Latches true the first time the probe actually resolves. A rejected probe
  // must NOT set this — a rejection is not evidence that no sources exist,
  // unlike a successful resolution to an empty list — so the rail's "no
  // searchable sources" copy stays honest instead of sticking around forever
  // after one failed `related:sources` call.
  const [sourcesProbed, setSourcesProbed] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [probeNonce, setProbeNonce] = useState(0)
  const seeded = useRef(false)

  useEffect(() => {
    let alive = true
    void window.argus.related
      .sources()
      .then((s) => {
        if (!alive) return
        setSources((prev) => {
          // Important 1 (second wave): the synthetic `related-history`
          // failure can land here too — `sources()` has its own pre-fan-out
          // catch-all — the same sticky-forever problem one layer up. This
          // probe has no per-call filter to reason about a REAL provider id
          // going stale the way `evictStale` does for search health, but a
          // fresh response that is not itself the catch-all firing again is
          // proof the failure is over: drop any leftover `service`-kind row
          // before folding the real list in.
          const base = s.some((x) => x.kind === 'service')
            ? prev
            : prev.filter((x) => x.kind !== 'service')
          return mergeById(base, s)
        })
        setSourcesProbed(true)
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
    // The full provider set for "which id did the user NOT uncheck" purposes
    // is the union of the (sticky) probe and the (sticky) last-known
    // per-provider health (see `unionProviderIds`) — the probe alone can
    // under-report (Important 1: `sources()` mirrors only the default fan-out
    // gate), and using either as a bare latest-round snapshot would let an
    // under-reported provider like `local` silently stay excluded from every
    // future request the moment it stops appearing in one round.
    const ids = unionProviderIds(sources, health)
    const input = toInput(req, caseSlug, ids)
    void window.argus.related
      .search(input)
      .then((r) => {
        if (!alive) return
        setCompleted({ req, result: r })
        // Important 1 (second wave): evict any sticky health entry this
        // request had a real chance to report — see `evictStale` — before
        // folding the fresh round in, so a stale id (the synthetic
        // `related-history` failure, a provider that dropped out of the
        // fan-out, a corpus removed from settings) can't outlive its own
        // eviction check by being immediately re-added by the merge.
        //
        // Critical: `evictStale` reasons from `r.sources` as though it were
        // produced by evaluating every requested provider — but two response
        // shapes reach here WITHOUT that ever happening.
        // `RelatedHistoryService.search` returns `query-too-generic` before
        // it ever calls `this.providers(...)` (a zero-term query is rejected
        // up front), and its catch-all replaces real per-provider health with
        // a single synthetic `kind: 'service'` entry. Both look identical, at
        // this layer, to "none of the requested providers exist any more" —
        // an empty (or service-only) `sources` array — but say nothing at all
        // about any real provider. Evicting on them would drop health this
        // round never had a chance to speak to: a healthy provider's probe
        // error would resurface the moment the user clears the search box
        // (`query-too-generic`, `sources: []`), and a health-only provider
        // would silently and permanently fall out of every later
        // `providerIds` union with no rail row left to re-check it back in. A
        // REAL `no-providers` is not this case — it is returned only AFTER
        // the provider list is computed, so it remains genuine evidence and
        // must stay evictable.
        const preFanOut =
          (r.sources.length === 0 && r.reason === 'query-too-generic') ||
          (r.sources.length > 0 && r.sources.every((s) => s.kind === 'service'))
        const reported = new Set(r.sources.map((s) => s.id))
        setHealth((prev) =>
          mergeById(preFanOut ? prev : evictStale(prev, input.providerIds, reported), r.sources)
        )
        // Echoed query seeds the box exactly once, so a user edit is never
        // overwritten by a later response.
        if (!seeded.current && !req.edited) {
          seeded.current = true
          setDraft(r.query)
        }
      })
      .catch((e: unknown) => {
        if (!alive) return
        // The last completed result (if any) stays on screen — same "no
        // flicker" reasoning as the success path — but a visible failure line
        // is mandatory here: unlike RelatedHistoryCard's silent swallow (a
        // rejection there must not break the case view), this surface is one
        // the user navigated to on purpose, so a broken source must be seen.
        setFailed({ req, message: e instanceof Error ? e.message : 'Search failed.' })
      })
    return () => {
      alive = false
    }
    // `sources` and `health` are read for provider ids only (see
    // `unionProviderIds` above); a probe landing, or a PRIOR request
    // completing, must not re-fire this search on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, caseSlug, shouldSearch])

  const error = failed?.req === req ? failed.message : null
  // A rejection for the *live* req must not keep pairing an older req's
  // successful `completed.result` with it — that result belongs to whatever
  // request produced it, not to the one that just failed. Gating on request
  // identity only when `error` is set (never unconditionally) keeps the
  // no-flicker behaviour for requests that are merely in flight: those still
  // show the previous result until the new one lands.
  const shown =
    shouldSearch && (!error || completed?.req === req) ? (completed?.result ?? null) : null
  const loading = shouldSearch && completed?.req !== req && !error
  const hits = shown?.hits ?? []
  const degraded = shown ? degradedLabel(shown.sources) : null
  const active = hits.find((h) => h.id === selected) ?? null
  const canShowMore = hits.length >= req.limit && req.limit < RELATED_SEARCH_MAX_LIMIT

  return (
    <div className="flex min-h-0 flex-1 gap-3 p-3">
      <ExplorerFilters
        req={req}
        sources={sources}
        health={health}
        probed={sourcesProbed}
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
        {error && <div className="text-[11px] text-danger">{error}</div>}
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
              <p className="text-xs text-dim">
                {emptyResultLabel(shown.reason, unionProviderIds(sources, health).length > 0)}
              </p>
            )}
            {!shown && !caseSlug && !error && (
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
              <HitDetail
                key={active.id}
                hit={active}
                onOpenCase={onOpenCase}
                caseSlug={caseSlug}
                sessionId={sessionId}
                onReferenced={onReferenced}
              />
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
  sessionId,
  onOpenCase,
  onClose
}: {
  caseSlug: string
  sessionId: number | null
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
      <RelatedHistoryExplorer
        caseSlug={caseSlug}
        sessionId={sessionId}
        onOpenCase={onOpenCase}
        // The composer this citation just filled sits UNDERNEATH this modal.
        // Staging text the user cannot see would be worse than not staging it.
        onReferenced={onClose}
      />
    </ModalShell>
  )
}

/** Standalone entry point: a top-level work surface, not a modal and not a
 *  Settings page — this is work, not configuration (spec §8). */
export function RelatedHistoryStandalone({
  onOpenCase,
  onClose
}: {
  onOpenCase: (slug: string) => void
  onClose: () => void
}): React.JSX.Element {
  useEscapeLayer({ onEscape: onClose })
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-hair px-3 py-2">
        <span className="flex items-center gap-2 font-mono text-sm text-ink">
          <History size={14} strokeWidth={1.5} />
          Related history
        </span>
        <IconBtn aria-label="Close" title="Close" onClick={onClose}>
          <X size={14} strokeWidth={1.5} />
        </IconBtn>
      </div>
      <RelatedHistoryExplorer onOpenCase={onOpenCase} />
    </div>
  )
}
