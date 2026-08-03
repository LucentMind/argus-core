import { useEffect, useState, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import type { SummarySearchHit } from '../../../shared/distill'
import type { SourceSearchResult } from '../../../shared/defectCorpus'
import { Card, Chip, IconBtn, SectionLabel } from './ui'
import { uiStore } from '../lib/uiStore'

/** One flattened row from a successful source's hits — carries the source name along since
 *  the row format (`key — summary (sourceName)`) needs it per-row, not per-result-batch. */
type CorpusRow = { sourceName: string; hit: SourceSearchResult['hits'][number] }

function dismissKey(slug: string): string {
  return `argus:similar-dismissed:${slug}`
}

function corpusDismissKey(slug: string): string {
  return `argus:known-defects-dismissed:${slug}`
}

/** Flattens ok-sources' hits into rows, per source order; failed sources are silently
 *  omitted (spec §5 — a dead source must never surface as an error in this card). */
function flattenCorpusHits(results: SourceSearchResult[]): CorpusRow[] {
  const rows: CorpusRow[] = []
  for (const r of results) {
    if (!r.ok) continue
    for (const hit of r.hits) rows.push({ sourceName: r.sourceName, hit })
  }
  return rows
}

export function SimilarCasesCard({
  slug,
  title,
  jiraKey,
  onOpenCase
}: {
  slug: string
  /** Case title, part of the corpus search query — same input the local `similarCases`
   *  path composes server-side from `[title, jiraKey]`. */
  title?: string
  jiraKey?: string | null
  onOpenCase?: (slug: string) => void
}): React.JSX.Element | null {
  const [hits, setHits] = useState<SummarySearchHit[]>([])
  const [dismissed, setDismissed] = useState(false)
  const [corpusHits, setCorpusHits] = useState<CorpusRow[]>([])
  const [corpusDismissed, setCorpusDismissed] = useState(false)
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const dynamic = ui.dynamicTheme

  useEffect(() => {
    const alreadyDismissed = Boolean(localStorage.getItem(dismissKey(slug)))
    const corpusAlreadyDismissed = Boolean(localStorage.getItem(corpusDismissKey(slug)))
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDismissed(alreadyDismissed)
    setCorpusDismissed(corpusAlreadyDismissed)
    setHits([])
    setCorpusHits([])
    let mounted = true
    if (!alreadyDismissed) {
      void window.argus.distill.similar(slug).then((r) => {
        if (mounted) setHits(r)
      })
    }
    // Same inputs the local `similarCases` path composes server-side (main's
    // distill/summaries.ts: `[c.title, c.jiraKey].filter(Boolean).join(' ')`) — an empty
    // query (no title/jiraKey known yet) skips the call entirely rather than sending ''.
    const query = [title, jiraKey].filter(Boolean).join(' ')
    if (!corpusAlreadyDismissed && query.trim()) {
      void window.argus.defects
        .search({ query, limit: 5 })
        .then((results) => {
          if (mounted) setCorpusHits(flattenCorpusHits(results))
        })
        .catch(() => {
          // defects.search's IPC call itself rejecting (distinct from a per-source
          // failure, which resolves with ok:false) must never block local hits from
          // rendering — swallow it and leave the known-defects section empty.
        })
    }
    return () => {
      mounted = false
    }
  }, [slug, title, jiraKey])

  const localVisible = !dismissed && hits.length > 0
  const corpusVisible = !corpusDismissed && corpusHits.length > 0
  if (!localVisible && !corpusVisible) return null

  function dismiss(): void {
    localStorage.setItem(dismissKey(slug), '1')
    setDismissed(true)
  }

  function dismissCorpus(): void {
    localStorage.setItem(corpusDismissKey(slug), '1')
    setCorpusDismissed(true)
  }

  return (
    <Card className={`flex flex-col gap-2 p-3 ${dynamic ? 'glass-panel' : ''}`}>
      {localVisible && (
        <>
          <div className="flex items-center justify-between gap-2">
            <SectionLabel>Similar past cases</SectionLabel>
            <IconBtn aria-label="Dismiss" onClick={dismiss}>
              <X size={14} strokeWidth={1.5} />
            </IconBtn>
          </div>
          <div className="flex flex-col gap-1.5">
            {hits.map((hit) => (
              <div key={hit.caseSlug} className="flex items-center gap-2">
                <button
                  className="min-w-0 flex-1 truncate text-left text-xs text-ink hover:text-signal"
                  onClick={() => onOpenCase?.(hit.caseSlug)}
                >
                  {hit.signature}
                </button>
                <Chip>{hit.resolution}</Chip>
              </div>
            ))}
          </div>
        </>
      )}
      {corpusVisible && (
        <>
          <div className="flex items-center justify-between gap-2">
            <SectionLabel>Known defects</SectionLabel>
            <IconBtn aria-label="Dismiss known defects" onClick={dismissCorpus}>
              <X size={14} strokeWidth={1.5} />
            </IconBtn>
          </div>
          <div className="flex flex-col gap-1.5">
            {corpusHits.map(({ sourceName, hit }) => (
              <a
                key={`${sourceName}:${hit.record.key}`}
                href={hit.record.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate text-left text-xs text-ink hover:text-signal"
              >
                {hit.record.key} — {hit.record.summary} ({sourceName})
              </a>
            ))}
          </div>
        </>
      )}
    </Card>
  )
}
