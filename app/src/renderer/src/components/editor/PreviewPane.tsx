import { useEffect, useRef } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { scrollFractionOf, scrollTopForFraction } from '../../lib/scrollSync'

export interface PreviewPaneProps {
  doc: string
  /** Where the editor is, 0–1. Applied on change. */
  scrollFraction?: number
  onScrollFraction?: (fraction: number) => void
}

/**
 * Spec §5.5: `react-markdown` + `remarkGfm` + `.markdown-body`, exactly as `FileViewer`,
 * `RefViewer` and `MessageView` render it. There is no second markdown pipeline in this app and
 * this must not become one — a preview that disagrees with the reader about its own content is
 * worse than no preview.
 */
export function PreviewPane({
  doc,
  scrollFraction,
  onScrollFraction
}: PreviewPaneProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const applying = useRef(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host || scrollFraction === undefined) return
    applying.current = true
    host.scrollTop = scrollTopForFraction(host, scrollFraction)
    // Cleared a frame later: the scroll event this assignment queues is dispatched
    // asynchronously, and letting it out would start the two panes chasing each other.
    const id = requestAnimationFrame(() => {
      applying.current = false
    })
    return () => cancelAnimationFrame(id)
  }, [scrollFraction, doc])

  return (
    <div
      ref={hostRef}
      onScroll={(e) => {
        if (applying.current) return
        onScrollFraction?.(scrollFractionOf(e.currentTarget))
      }}
      className="markdown-body min-h-0 min-w-0 flex-1 overflow-auto p-4 text-sm leading-relaxed text-ink"
    >
      <Markdown remarkPlugins={[remarkGfm]}>{doc}</Markdown>
    </div>
  )
}
