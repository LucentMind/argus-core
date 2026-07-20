import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Btn } from './ui'
import { ModalShell } from './ModalShell'
import type { FileReadResult } from '../../../shared/types'

export function FileViewer({
  slug,
  relPath,
  onClose
}: {
  slug: string
  relPath: string
  onClose: () => void
}): React.JSX.Element {
  const [doc, setDoc] = useState<FileReadResult | null>(null)
  const [error, setError] = useState(false)
  const [raw, setRaw] = useState(false)
  const isMd = /\.md$/i.test(relPath)

  // adjust-state-during-render pattern: reset doc when slug/relPath changes
  const key = `${slug}:${relPath}`
  const [lastKey, setLastKey] = useState(key)
  if (key !== lastKey) {
    setLastKey(key)
    setDoc(null)
    setError(false)
  }

  useEffect(() => {
    window.argus.files.read(slug, relPath).then(setDoc, () => setError(true))
  }, [slug, relPath])

  return (
    <ModalShell
      title={`${slug} / ${relPath}`}
      onClose={onClose}
      actions={
        isMd && doc && 'content' in doc ? (
          <Btn variant="ghost" onClick={() => setRaw(!raw)}>
            {raw ? 'Rendered' : 'Raw'}
          </Btn>
        ) : null
      }
    >
      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-dim">
          File could not be read.
        </div>
      ) : doc && 'tooLarge' in doc ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-dim">
          File is larger than the in-app viewer limit.
          <Btn onClick={() => void window.argus.files.open(slug, relPath)}>Open externally</Btn>
        </div>
      ) : isMd && !raw ? (
        <div className="markdown-body flex-1 overflow-auto p-4 text-sm leading-relaxed text-ink">
          {doc && 'content' in doc ? (
            <Markdown remarkPlugins={[remarkGfm]}>{doc.content}</Markdown>
          ) : (
            'Loading…'
          )}
        </div>
      ) : (
        <pre className="flex-1 overflow-auto p-3 font-mono text-xs leading-5 text-dim">
          {doc && 'content' in doc ? doc.content : 'Loading…'}
        </pre>
      )}
    </ModalShell>
  )
}
