import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import { linkifyCitations, parseCiteHref } from '../lib/citations'
import { CitationCard } from './CitationCard'

export function MessageView({
  markdown,
  onCite,
  caseSlug,
  citationMode = 'collapsed'
}: {
  markdown: string
  onCite: (relPath: string, line: number) => void
  /** When set, citations render as CitationCard chips; without it (e.g. the
   *  proposals tab, which has no case context) they stay plain links. */
  caseSlug?: string
  citationMode?: 'collapsed' | 'expanded'
}): React.JSX.Element {
  return (
    <div className="prose-sm max-w-none text-sm leading-relaxed text-ink [&_code]:font-mono [&_code]:text-signal">
      <ReactMarkdown
        // the default transform strips unknown protocols like cite://
        urlTransform={(url) => (url.startsWith('cite://') ? url : defaultUrlTransform(url))}
        components={{
          // Expanded citation cards are block elements, which can't nest inside
          // <p> — render paragraphs as divs (identical under preflight's zero margins).
          p: ({ children }) => <div>{children}</div>,
          a: ({ href, children }) => {
            const cite = href ? parseCiteHref(href) : null
            if (cite && caseSlug) {
              return (
                <CitationCard
                  caseSlug={caseSlug}
                  relPath={cite.relPath}
                  line={cite.line}
                  defaultExpanded={citationMode === 'expanded'}
                  onOpenViewer={onCite}
                />
              )
            }
            if (cite) {
              return (
                <a
                  href={href}
                  className="font-mono text-xs text-defect underline decoration-dotted"
                  onClick={(e) => {
                    e.preventDefault()
                    onCite(cite.relPath, cite.line)
                  }}
                >
                  {children}
                </a>
              )
            }
            return (
              <a href={href} target="_blank" rel="noreferrer" className="text-signal underline">
                {children}
              </a>
            )
          }
        }}
      >
        {linkifyCitations(markdown)}
      </ReactMarkdown>
    </div>
  )
}
