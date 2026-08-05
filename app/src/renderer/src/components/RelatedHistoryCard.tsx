import { useEffect, useState, useSyncExternalStore } from 'react'
import { ChevronDown, ChevronRight, X } from 'lucide-react'
import type {
  LocalCaseHit,
  RelatedHit,
  RelatedSearchResult,
  SourceHealth
} from '../../../shared/relatedHistory'
import { Card, Chip, IconBtn, SectionLabel } from './ui'
import { uiStore } from '../lib/uiStore'
import { isOpenableUrl } from '../lib/openableUrl'

const DISMISS_KEY = (slug: string): string => `argus:related-dismissed:${slug}`
/** Pre-merge keys. A user who dismissed either half keeps it dismissed. */
const LEGACY_KEYS = (slug: string): string[] => [
  `argus:similar-dismissed:${slug}`,
  `argus:known-defects-dismissed:${slug}`
]

function isLocal(hit: RelatedHit): hit is LocalCaseHit {
  return hit.kind === 'local'
}

function statusTone(tone: RelatedHit['status']['tone']): 'neutral' | 'signal' | 'review' {
  if (tone === 'forwarded') return 'review'
  if (tone === 'open') return 'signal'
  return 'neutral'
}

function degradedLabel(sources: SourceHealth[]): string | null {
  const failed = sources.filter((s) => !s.ok)
  if (failed.length === 0) return null
  if (failed.length === 1) return `${failed[0].name} unavailable`
  return `${failed.length} sources unavailable`
}

function HitRow({
  hit,
  expanded,
  onToggle,
  onOpenCase
}: {
  hit: RelatedHit
  expanded: boolean
  onToggle: () => void
  onOpenCase?: (slug: string) => void
}): React.JSX.Element {
  // A local hit opens its case; a corpus-only hit links out, but only when the
  // corpus-supplied url survives the guard. Deep-linking a MERGED row to its
  // corpus record (`hit.corpusRef.url`) is not read here — that link is
  // increment 2's detail view, not this row's primary action.
  const primary = isLocal(hit) ? (
    <button
      className="min-w-0 flex-1 truncate text-left text-xs text-ink hover:text-signal"
      onClick={() => onOpenCase?.(hit.caseSlug)}
    >
      {hit.title}
    </button>
  ) : hit.url && isOpenableUrl(hit.url) ? (
    <a
      href={hit.url}
      target="_blank"
      rel="noreferrer"
      className="min-w-0 flex-1 truncate text-left text-xs text-ink hover:text-signal"
    >
      {hit.key} — {hit.title}
    </a>
  ) : (
    <span className="min-w-0 flex-1 truncate text-xs text-ink">
      {hit.key} — {hit.title}
    </span>
  )

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {hit.distilled ? (
          <IconBtn
            size="xs"
            aria-label={`Details for ${hit.title}`}
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? (
              <ChevronDown size={12} strokeWidth={1.5} />
            ) : (
              <ChevronRight size={12} strokeWidth={1.5} />
            )}
          </IconBtn>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        {primary}
        {hit.provenance.map((p) => (
          <Chip key={p.providerId} tone={p.kind === 'local' ? 'neutral' : 'signal'}>
            {p.providerName}
          </Chip>
        ))}
        {/* Spec §7: a semantic-hit affordance. Also the only place `fuse`'s
            widening of a merged row's matchedOn to 'both' is observable. */}
        {(hit.matchedOn === 'semantic' || hit.matchedOn === 'both') && (
          <Chip tone="defect">semantic</Chip>
        )}
        <Chip tone={statusTone(hit.status.tone)}>{hit.status.label}</Chip>
      </div>
      {expanded && hit.distilled && (
        <div className="ml-7 flex flex-col gap-0.5 text-[11px] text-dim">
          {hit.distilled.rootCause && (
            <div>
              <span className="text-mute">Root cause: </span>
              {hit.distilled.rootCause}
            </div>
          )}
          {hit.distilled.fix && (
            <div>
              <span className="text-mute">Fix: </span>
              {hit.distilled.fix}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * One merged, rank-fused related-history list: the user's own closed cases and
 * every configured defect corpus, ordered together (spec §7).
 *
 * Takes only `slug` — query composition lives in main (`relatedHistory/query.ts`)
 * so there is exactly one copy of the rule, unlike the pre-merge card which
 * re-composed `[title, jiraKey]` on this side of the process boundary.
 */
export function RelatedHistoryCard({
  slug,
  onOpenCase,
  onOpenExplorer
}: {
  slug: string
  onOpenCase?: (slug: string) => void
  onOpenExplorer?: () => void
}): React.JSX.Element | null {
  const [result, setResult] = useState<RelatedSearchResult | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )

  useEffect(() => {
    const already =
      Boolean(localStorage.getItem(DISMISS_KEY(slug))) ||
      LEGACY_KEYS(slug).some((k) => Boolean(localStorage.getItem(k)))
    // Syncing dismissal state read from localStorage at mount/slug-change, not a
    // cascading re-render off React state, so this is fine here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDismissed(already)
    setResult(null)
    setExpanded(null)
    if (already) return
    let mounted = true
    void window.argus.related
      .search({ caseSlug: slug })
      .then((r) => {
        if (mounted) setResult(r)
      })
      .catch(() => {
        // An IPC-level rejection must never break the case view; the card just
        // stays absent.
      })
    return () => {
      mounted = false
    }
  }, [slug])

  const degraded = result ? degradedLabel(result.sources) : null
  // Render when there is something to show OR something is broken. Returning null
  // on zero hits alone would make an outage indistinguishable from "nothing
  // similar" — the exact failure this feature exists to end (spec §11).
  if (dismissed || !result || (result.hits.length === 0 && !degraded)) return null

  function dismiss(): void {
    localStorage.setItem(DISMISS_KEY(slug), '1')
    setDismissed(true)
  }

  return (
    <Card className={`flex flex-col gap-2 p-3 ${ui.dynamicTheme ? 'glass-panel' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Related history</SectionLabel>
        <IconBtn aria-label="Dismiss" onClick={dismiss}>
          <X size={14} strokeWidth={1.5} />
        </IconBtn>
      </div>
      {degraded && <div className="text-[11px] text-mute">{degraded}</div>}
      <div className="flex flex-col gap-1.5">
        {result.hits.map((hit) => (
          <HitRow
            key={hit.id}
            hit={hit}
            expanded={expanded === hit.id}
            onToggle={() => setExpanded(expanded === hit.id ? null : hit.id)}
            onOpenCase={onOpenCase}
          />
        ))}
      </div>
      {onOpenExplorer && (
        <button
          type="button"
          aria-label="Search all history"
          onClick={onOpenExplorer}
          className="self-start text-[11px] text-mute hover:text-signal"
        >
          Search all history →
        </button>
      )}
    </Card>
  )
}
