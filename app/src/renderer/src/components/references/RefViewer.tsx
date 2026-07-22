import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Btn } from '../ui'
import { ModalShell } from '../ModalShell'

/** Generic modal markdown viewer (FileViewer idiom) — refs and skills share it. */
export function MarkdownViewer({
  title,
  ariaLabel,
  load,
  onClose
}: {
  title: string
  ariaLabel: string
  load: () => Promise<string>
  onClose: () => void
}): React.JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [raw, setRaw] = useState(false)

  useEffect(() => {
    load().then(setContent, () => setError(true))
    // load is mount-stable: callers remount (key/conditional render) per file
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <ModalShell
      title={title}
      onClose={onClose}
      ariaLabel={ariaLabel}
      className="h-[80vh] w-[80vw] max-w-4xl"
      actions={
        content != null ? (
          <Btn variant="ghost" onClick={() => setRaw(!raw)}>
            {raw ? 'Rendered' : 'Raw'}
          </Btn>
        ) : null
      }
    >
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
    </ModalShell>
  )
}

/** Modal markdown viewer for a reference file (refsync-served). */
export function RefViewer({
  file,
  onClose
}: {
  file: string
  onClose: () => void
}): React.JSX.Element {
  return (
    <MarkdownViewer
      key={file}
      title={`references / ${file}`}
      ariaLabel={`reference · ${file}`}
      load={() => window.argus.refsync.readRef(file).then((r) => r.content)}
      onClose={onClose}
    />
  )
}
