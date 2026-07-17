import { classifyCitePath, splitCitations, toRepoNameSet, type CiteTarget } from '../lib/citations'
import { CitationCard } from './CitationCard'
import type { CiteSource } from '../lib/snippetCache'

function citeSource(caseSlug: string, cite: CiteTarget, names: ReadonlySet<string>): CiteSource {
  if (classifyCitePath(cite.relPath, names) === 'repo') {
    const slash = cite.relPath.indexOf('/')
    return {
      kind: 'repo',
      caseSlug,
      repoName: cite.relPath.slice(0, slash),
      relPath: cite.relPath.slice(slash + 1)
    }
  }
  return { kind: 'evidence', caseSlug, relPath: cite.relPath }
}

/**
 * Render plain text with any `[path:line]` citations made interactive — for
 * USER messages, which are otherwise shown as raw text (not through the markdown
 * renderer). With a caseSlug the citation is an expandable CitationCard chip;
 * without one it falls back to a plain link. Non-citation text is left as typed.
 */
export function CitedText({
  text,
  onCite,
  caseSlug,
  repoNames = []
}: {
  text: string
  onCite: (cite: CiteTarget) => void
  caseSlug?: string
  repoNames?: readonly string[]
}): React.JSX.Element {
  const names = toRepoNameSet(repoNames)
  return (
    <>
      {splitCitations(text, repoNames).map((seg, i) => {
        if (seg.type !== 'cite') return <span key={i}>{seg.text}</span>
        const cite: CiteTarget = { relPath: seg.relPath, start: seg.start, end: seg.end }
        const label = seg.end > seg.start ? `${seg.start}-${seg.end}` : `${seg.start}`
        if (caseSlug) {
          return (
            <CitationCard
              key={i}
              source={citeSource(caseSlug, cite, names)}
              start={seg.start}
              end={seg.end}
              defaultExpanded={false}
              onOpenViewer={() => onCite(cite)}
            />
          )
        }
        return (
          <a
            key={i}
            href={`cite://${seg.relPath}?line=${seg.start}${seg.end > seg.start ? `&end=${seg.end}` : ''}`}
            className="font-mono text-xs text-defect underline decoration-dotted"
            onClick={(e) => {
              e.preventDefault()
              onCite(cite)
            }}
          >
            {seg.relPath}:{label}
          </a>
        )
      })}
    </>
  )
}
