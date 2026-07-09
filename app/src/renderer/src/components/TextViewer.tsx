import { useEffect, useState } from 'react'
import { Btn } from './ui'

interface Props {
  evidenceId: number
  focusLine: number
  onClose: () => void
}

export function TextViewer({ evidenceId, focusLine, onClose }: Props): React.JSX.Element {
  const [doc, setDoc] = useState<{ relPath: string; caseSlug: string; content: string } | null>(null)

  useEffect(() => {
    void window.argus.evidence.read(evidenceId).then(setDoc)
  }, [evidenceId])

  useEffect(() => {
    if (doc) document.getElementById(`line-${focusLine}`)?.scrollIntoView({ block: 'center' })
  }, [doc, focusLine])

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
            {doc ? `${doc.caseSlug} / ${doc.relPath}` : 'Loading…'}
          </span>
          <Btn variant="ghost" onClick={onClose}>
            Close
          </Btn>
        </div>
        <pre className="flex-1 overflow-auto p-3 font-mono text-xs leading-5 text-dim">
          {doc?.content.split('\n').map((line, i) => (
            <div
              key={i}
              id={`line-${i + 1}`}
              className={i + 1 === focusLine ? 'bg-defect/20 text-ink' : undefined}
            >
              <span className="mr-3 inline-block w-10 select-none text-right text-mute">
                {i + 1}
              </span>
              {line}
            </div>
          ))}
        </pre>
      </div>
    </div>
  )
}
