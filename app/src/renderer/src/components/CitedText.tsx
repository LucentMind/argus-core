import { splitCitations } from '../lib/citations'

/**
 * Render plain text with any `[relPath:line]` citations turned into clickable
 * links — for USER messages, which are otherwise shown as raw text (not through
 * the markdown renderer). Non-citation text is left exactly as typed.
 */
export function CitedText({
  text,
  onCite
}: {
  text: string
  onCite: (relPath: string, line: number) => void
}): React.JSX.Element {
  return (
    <>
      {splitCitations(text).map((seg, i) =>
        seg.type === 'cite' ? (
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
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </>
  )
}
