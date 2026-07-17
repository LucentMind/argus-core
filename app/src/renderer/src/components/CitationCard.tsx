import { useEffect, useState } from 'react'
import { ChevronRight, ChevronUp, ExternalLink, FileCode2, FileText } from 'lucide-react'
import { langForPath } from '../../../shared/snippets'
import { fetchSnippet, type AnySnippetResult, type CiteSource } from '../lib/snippetCache'
import { displayName } from '../lib/evidenceDisplay'
import { HighlightedLines } from './HighlightedLines'
import { Chip } from './ui'

const CARD_BTN = 'rounded-r1 p-0.5 text-mute transition-colors hover:bg-hair hover:text-ink'

/** Compact chip label: evidence keeps its display name; repo shows repo/basename. */
function chipLabel(source: CiteSource): string {
  if (source.kind === 'evidence') return displayName(source.relPath)
  const base = source.relPath.slice(source.relPath.lastIndexOf('/') + 1)
  return `${source.repoName}/${base}`
}

function fullPath(source: CiteSource): string {
  return source.kind === 'evidence' ? source.relPath : `${source.repoName}/${source.relPath}`
}

function unavailableNote(source: CiteSource, reason: 'not-found' | 'repo-not-linked'): string {
  if (reason === 'repo-not-linked') return 'repo not linked — link a checkout to preview'
  return source.kind === 'repo'
    ? 'file not found in this repo'
    : 'evidence unavailable — it may have been deleted or renamed'
}

/** A citation as an expandable inline card: a compact chip in the text flow;
 *  expanded, a block snippet preview around the cited range with a one-click
 *  path to the full viewer. Fetches lazily on expand (cached). */
export function CitationCard({
  source,
  start,
  end,
  defaultExpanded,
  onOpenViewer
}: {
  source: CiteSource
  start: number
  end: number
  defaultExpanded: boolean
  onOpenViewer: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [snippet, setSnippet] = useState<AnySnippetResult | null>(null)
  // adjust-state-during-render: a mounted card whose citation identity changes
  // must drop the old snippet and refetch (expanded cards don't otherwise
  // live-refresh — see the fetch effect note below)
  const identity = `${source.kind}|${source.caseSlug}|${fullPath(source)}|${start}-${end}`
  const [lastIdentity, setLastIdentity] = useState(identity)
  if (identity !== lastIdentity) {
    setLastIdentity(identity)
    setSnippet(null)
  }
  const { kind } = langForPath(source.relPath)
  const Icon = kind === 'code' ? FileCode2 : FileText
  const rangeLabel = end > start ? `${start}-${end}` : `${start}`

  // NOTE: an already-expanded card keeps its fetched snippet even if the
  // underlying file changes on disk (cache invalidates, mounted state doesn't)
  // — accepted: re-open the card or viewer to refresh.
  useEffect(() => {
    if (!expanded || snippet !== null) return
    let alive = true
    void fetchSnippet(source, start, end).then((s) => {
      if (alive) setSnippet(s)
    })
    return () => {
      alive = false
    }
  }, [expanded, snippet, source, start, end])

  return (
    <>
      <button
        type="button"
        aria-expanded={expanded}
        title={`${fullPath(source)}:${rangeLabel}`}
        onClick={() => setExpanded((e) => !e)}
        className={`inline-flex items-center gap-1 align-baseline rounded-r1 border border-defect/30 px-1 font-mono text-[11px] leading-4 text-defect transition-colors hover:border-defect/60 ${
          expanded ? 'bg-defect/10' : 'bg-hair/50'
        }`}
      >
        <Icon size={11} strokeWidth={1.5} className="shrink-0" />
        {chipLabel(source)}:{rangeLabel}
        <ChevronRight
          size={10}
          strokeWidth={2}
          className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </button>
      {expanded && (
        <div className="my-1.5 block w-full overflow-hidden rounded-r2 border border-hair bg-deep">
          <div className="flex items-center gap-1.5 border-b border-hair px-2 py-1">
            <Icon size={12} strokeWidth={1.5} className="shrink-0 text-mute" />
            <span className="truncate font-mono text-[11px] text-dim">
              {fullPath(source)}:{rangeLabel}
            </span>
            {snippet?.ok === true && 'ref' in snippet && snippet.ref && (
              <Chip tone="neutral">@ {snippet.ref}</Chip>
            )}
            {snippet?.ok === true && snippet.truncated === true && (
              <Chip tone="neutral">first lines only</Chip>
            )}
            <span className="flex-1" />
            <button
              type="button"
              aria-label="Open in viewer"
              title="Open in viewer"
              className={CARD_BTN}
              onClick={onOpenViewer}
            >
              <ExternalLink size={12} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              aria-label="Collapse citation"
              title="Collapse"
              className={CARD_BTN}
              onClick={() => setExpanded(false)}
            >
              <ChevronUp size={12} strokeWidth={1.5} />
            </button>
          </div>
          {snippet === null ? (
            <div className="px-3 py-2 font-mono text-xs text-mute">Loading…</div>
          ) : !snippet.ok ? (
            <div className="px-3 py-2 text-xs text-mute">
              {unavailableNote(source, snippet.reason)}
            </div>
          ) : snippet.lines.length === 0 ? (
            <div className="px-3 py-2 text-xs text-mute">
              line {start} is past the end of this file
            </div>
          ) : (
            <div
              role="button"
              tabIndex={0}
              className="cursor-pointer transition-colors hover:bg-hi"
              title="Open in viewer"
              onClick={onOpenViewer}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onOpenViewer()
                }
              }}
            >
              <HighlightedLines
                lines={snippet.lines}
                startLine={snippet.startLine}
                focusStart={start}
                focusEnd={end}
                lang={snippet.lang}
                className="px-2 py-1"
              />
            </div>
          )}
        </div>
      )}
    </>
  )
}
