import { useEffect, useState } from 'react'
import { ChevronRight, ChevronUp, ExternalLink, FileCode2, FileText } from 'lucide-react'
import { langForPath, type SnippetResult } from '../../../shared/snippets'
import { fetchSnippet } from '../lib/snippetCache'
import { displayName } from '../lib/evidenceDisplay'
import { HighlightedLines } from './HighlightedLines'

const CARD_BTN = 'rounded-r1 p-0.5 text-mute transition-colors hover:bg-hair hover:text-ink'

/** An evidence citation as an expandable inline card: a compact chip in the text
 *  flow; expanded, a block snippet preview around the cited line with a one-click
 *  path to the full TextViewer. Fetches lazily on expand (cached). */
export function CitationCard({
  caseSlug,
  relPath,
  line,
  defaultExpanded,
  onOpenViewer
}: {
  caseSlug: string
  relPath: string
  line: number
  defaultExpanded: boolean
  onOpenViewer: (relPath: string, line: number) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [snippet, setSnippet] = useState<SnippetResult | null>(null)
  const { kind } = langForPath(relPath)
  const Icon = kind === 'code' ? FileCode2 : FileText

  useEffect(() => {
    if (!expanded || snippet !== null) return
    let alive = true
    void fetchSnippet(caseSlug, relPath, line).then((s) => {
      if (alive) setSnippet(s)
    })
    return () => {
      alive = false
    }
  }, [expanded, snippet, caseSlug, relPath, line])

  const openViewer = (): void => onOpenViewer(relPath, line)

  return (
    <>
      <button
        type="button"
        aria-expanded={expanded}
        title={`${relPath}:${line}`}
        onClick={() => setExpanded((e) => !e)}
        className={`inline-flex items-center gap-1 align-baseline rounded-r1 border border-defect/30 px-1 font-mono text-[11px] leading-4 text-defect transition-colors hover:border-defect/60 ${
          expanded ? 'bg-defect/10' : 'bg-hair/50'
        }`}
      >
        <Icon size={11} strokeWidth={1.5} className="shrink-0" />
        {displayName(relPath)}:{line}
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
              {relPath}:{line}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              aria-label="Open in viewer"
              title="Open in viewer"
              className={CARD_BTN}
              onClick={openViewer}
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
              evidence unavailable — it may have been deleted or renamed
            </div>
          ) : snippet.lines.length === 0 ? (
            <div className="px-3 py-2 text-xs text-mute">
              line {line} is past the end of this file
            </div>
          ) : (
            <div
              role="button"
              tabIndex={0}
              className="cursor-pointer transition-colors hover:bg-hi"
              title="Open in viewer"
              onClick={openViewer}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  openViewer()
                }
              }}
            >
              <HighlightedLines
                lines={snippet.lines}
                startLine={snippet.startLine}
                focusLine={line}
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
