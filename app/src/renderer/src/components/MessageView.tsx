import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import { linkifyCitations, parseCiteHref } from '../lib/citations'

export function MessageView({
  markdown,
  onCite
}: {
  markdown: string
  onCite: (relPath: string, line: number) => void
}): React.JSX.Element {
  return (
    <div className="prose-sm max-w-none text-sm leading-relaxed text-ink [&_code]:font-mono [&_code]:text-signal">
      <ReactMarkdown
        // the default transform strips unknown protocols like cite://
        urlTransform={(url) => (url.startsWith('cite://') ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children }) => {
            const cite = href ? parseCiteHref(href) : null
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
