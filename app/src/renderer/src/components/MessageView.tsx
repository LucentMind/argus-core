import { isValidElement } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  classifyCitePath,
  linkifyCitations,
  parseCiteHref,
  toRepoNameSet,
  type CiteTarget
} from '../lib/citations'
import { CitationCard } from './CitationCard'
import { MermaidBlock } from './MermaidBlock'
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

export function MessageView({
  markdown,
  onCite,
  caseSlug,
  citationMode = 'collapsed',
  repoNames = [],
  streaming = false
}: {
  markdown: string
  onCite: (cite: CiteTarget) => void
  /** When set, citations render as CitationCard chips; without it (e.g. the
   *  proposals tab, which has no case context) they stay plain links. */
  caseSlug?: string
  citationMode?: 'collapsed' | 'expanded'
  /** Linked repo names for this case — enables the repo citation domain. */
  repoNames?: readonly string[]
  /** True while this message is still streaming — mermaid fences stay as code
   *  blocks until the fence is guaranteed complete. */
  streaming?: boolean
}): React.JSX.Element {
  const names = toRepoNameSet(repoNames)
  return (
    <div className="markdown-body max-w-none text-sm leading-relaxed text-ink">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // the default transform strips unknown protocols like cite://
        urlTransform={(url) => (url.startsWith('cite://') ? url : defaultUrlTransform(url))}
        components={{
          // Expanded citation cards are block elements, which can't nest inside
          // <p> — render paragraphs as divs (identical under preflight's zero margins).
          p: ({ children }) => <div>{children}</div>,
          pre: ({ children, ...rest }) => {
            const child = Array.isArray(children) ? children[0] : children
            if (isValidElement(child)) {
              const props = child.props as { className?: string; children?: unknown }
              if (
                typeof props.className === 'string' &&
                props.className.includes('language-mermaid') &&
                typeof props.children === 'string'
              ) {
                return <MermaidBlock source={props.children} streaming={streaming} />
              }
            }
            return <pre {...rest}>{children}</pre>
          },
          a: ({ href, children }) => {
            const cite = href ? parseCiteHref(href) : null
            if (cite && caseSlug) {
              return (
                <CitationCard
                  source={citeSource(caseSlug, cite, names)}
                  start={cite.start}
                  end={cite.end}
                  defaultExpanded={citationMode === 'expanded'}
                  onOpenViewer={() => onCite(cite)}
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
                    onCite(cite)
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
        {linkifyCitations(markdown, repoNames)}
      </ReactMarkdown>
    </div>
  )
}
