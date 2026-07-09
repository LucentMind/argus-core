import { useEffect, useState } from 'react'

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
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="flex h-[80vh] w-[80vw] flex-col rounded bg-neutral-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-700 px-3 py-2">
          <span className="text-sm">{doc ? `${doc.caseSlug} / ${doc.relPath}` : 'Loading…'}</span>
          <button className="rounded bg-neutral-700 px-2 py-0.5 text-xs" onClick={onClose}>
            Close
          </button>
        </div>
        <pre className="flex-1 overflow-auto p-3 text-xs leading-5">
          {doc?.content.split('\n').map((line, i) => (
            <div
              key={i}
              id={`line-${i + 1}`}
              className={i + 1 === focusLine ? 'bg-yellow-900/50' : undefined}
            >
              <span className="mr-3 inline-block w-10 select-none text-right text-neutral-600">{i + 1}</span>
              {line}
            </div>
          ))}
        </pre>
      </div>
    </div>
  )
}
