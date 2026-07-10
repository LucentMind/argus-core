import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import { Btn } from './ui'
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
  const [raw, setRaw] = useState(false)
  const isMd = /\.md$/i.test(relPath)

  // adjust-state-during-render pattern: reset doc when slug/relPath changes
  const key = `${slug}:${relPath}`
  const [lastKey, setLastKey] = useState(key)
  if (key !== lastKey) {
    setLastKey(key)
    setDoc(null)
  }

  useEffect(() => {
    void window.argus.files.read(slug, relPath).then(setDoc)
  }, [slug, relPath])

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="flex h-[80vh] w-[80vw] flex-col rounded-r4 border border-hair2 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hair px-3 py-2">
          <span className="font-mono text-sm text-ink">
            {slug} / {relPath}
          </span>
          <span className="flex items-center gap-2">
            {isMd && doc && 'content' in doc && (
              <Btn variant="ghost" onClick={() => setRaw(!raw)}>
                {raw ? 'Rendered' : 'Raw'}
              </Btn>
            )}
            <Btn variant="ghost" onClick={onClose}>
              Close
            </Btn>
          </span>
        </div>
        {doc && 'tooLarge' in doc ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-dim">
            File is larger than the in-app viewer limit.
            <Btn onClick={() => void window.argus.files.open(slug, relPath)}>Open externally</Btn>
          </div>
        ) : isMd && !raw ? (
          <div className="prose-sm flex-1 overflow-auto p-4 text-sm leading-relaxed text-ink [&_code]:font-mono [&_code]:text-signal">
            <Markdown>{doc && 'content' in doc ? doc.content : ''}</Markdown>
          </div>
        ) : (
          <pre className="flex-1 overflow-auto p-3 font-mono text-xs leading-5 text-dim">
            {doc && 'content' in doc ? doc.content : 'Loading…'}
          </pre>
        )}
      </div>
    </div>
  )
}
