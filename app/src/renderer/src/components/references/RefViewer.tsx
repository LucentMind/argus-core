import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Btn } from '../ui'

/** Modal markdown viewer for a reference file (FileViewer idiom, refsync-served). */
export function RefViewer({
  file,
  onClose
}: {
  file: string
  onClose: () => void
}): React.JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [raw, setRaw] = useState(false)

  useEffect(() => {
    window.argus.refsync.readRef(file).then(
      (r) => setContent(r.content),
      () => setError(true)
    )
  }, [file])

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={`reference · ${file}`}
        className="flex h-[80vh] w-[80vw] max-w-4xl flex-col rounded-r4 border border-hair2 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hair px-3 py-2">
          <span className="font-mono text-sm text-ink">references / {file}</span>
          <span className="flex items-center gap-2">
            {content != null && (
              <Btn variant="ghost" onClick={() => setRaw(!raw)}>
                {raw ? 'Rendered' : 'Raw'}
              </Btn>
            )}
            <Btn variant="ghost" onClick={onClose}>
              Close
            </Btn>
          </span>
        </div>
        {error ? (
          <div className="flex flex-1 items-center justify-center text-sm text-dim">
            File could not be read.
          </div>
        ) : !raw ? (
          <div className="markdown-body flex-1 overflow-auto p-4 text-sm leading-relaxed text-ink">
            {content != null ? (
              <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
            ) : (
              'Loading…'
            )}
          </div>
        ) : (
          <pre className="flex-1 overflow-auto p-3 font-mono text-xs leading-5 text-dim">
            {content}
          </pre>
        )}
      </div>
    </div>
  )
}
