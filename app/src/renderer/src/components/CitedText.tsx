import { splitCitations } from '../lib/citations'
import { CitationCard } from './CitationCard'

/**
 * Render plain text with any `[relPath:line]` citations made interactive — for
 * USER messages, which are otherwise shown as raw text (not through the markdown
 * renderer). With a caseSlug the citation is an expandable CitationCard chip;
 * without one it falls back to a plain link. Non-citation text is left as typed.
 */
export function CitedText({
  text,
  onCite,
  caseSlug
}: {
  text: string
  onCite: (relPath: string, line: number) => void
  caseSlug?: string
}): React.JSX.Element {
  return (
    <>
      {splitCitations(text).map((seg, i) => {
        if (seg.type !== 'cite') return <span key={i}>{seg.text}</span>
        if (caseSlug) {
          return (
            <CitationCard
              key={i}
              caseSlug={caseSlug}
              relPath={seg.relPath}
              line={seg.line}
              defaultExpanded={false}
              onOpenViewer={onCite}
            />
          )
        }
        return (
          <a
            key={i}
            href={`cite://${seg.relPath}?line=${seg.line}`}
            className="font-mono text-xs text-defect underline decoration-dotted"
            onClick={(e) => {
              e.preventDefault()
              onCite(seg.relPath, seg.line)
            }}
          >
            {seg.relPath}:{seg.line}
          </a>
        )
      })}
    </>
  )
}
