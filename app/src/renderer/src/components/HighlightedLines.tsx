import { useEffect, useState } from 'react'
import { ensureLanguage, highlightLine, isRegistered } from '../lib/highlight'

/** Numbered monospace lines with an optional focus-line highlight and optional
 *  syntax highlighting. Shared by CitationCard (snippet) and TextViewer (full doc).
 *  Renders plain text until the language chunk has loaded. */
export function HighlightedLines({
  lines,
  startLine,
  focusStart,
  focusEnd,
  lang,
  lineIdPrefix,
  className = ''
}: {
  lines: string[]
  startLine: number
  focusStart: number | null
  focusEnd: number | null
  lang: string | null
  lineIdPrefix?: string
  className?: string
}): React.JSX.Element {
  const [, bump] = useState(0)
  const canHighlight = lang !== null && isRegistered(lang)
  useEffect(() => {
    if (lang === null || isRegistered(lang)) return
    let alive = true
    void ensureLanguage(lang).then((ok) => {
      if (alive && ok) bump((n) => n + 1)
    })
    return () => {
      alive = false
    }
  }, [lang])
  return (
    <pre className={`overflow-auto font-mono text-xs leading-5 text-dim ${className}`}>
      {lines.map((line, i) => {
        const n = startLine + i
        return (
          <div
            key={n}
            id={lineIdPrefix ? `${lineIdPrefix}${n}` : undefined}
            className={
              focusStart !== null && n >= focusStart && n <= (focusEnd ?? focusStart)
                ? 'bg-defect/20 text-ink'
                : undefined
            }
          >
            <span className="mr-3 inline-block w-10 select-none text-right text-mute">{n}</span>
            {canHighlight && lang ? (
              <span dangerouslySetInnerHTML={{ __html: highlightLine(line, lang) }} />
            ) : (
              <span>{line}</span>
            )}
          </div>
        )
      })}
    </pre>
  )
}
