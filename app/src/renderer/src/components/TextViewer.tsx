import { useEffect, useState } from 'react'
import { Btn, Chip } from './ui'
import { HighlightedLines } from './HighlightedLines'
import { langForPath } from '../../../shared/snippets'

export type ViewerSource =
  | { kind: 'evidence'; evidenceId: number }
  | { kind: 'repo'; caseSlug: string; repoName: string; relPath: string }

interface Props {
  source: ViewerSource
  focusStart: number
  focusEnd: number
  onClose: () => void
}

interface Doc {
  title: string
  content: string
  startLine: number
  truncated: boolean
  lang: string | null
  ref: string | null
  /** evidence-only: caseSlug + relPath for the derived-from lookup */
  caseSlug?: string
  relPath?: string
  evidenceId?: number
}

function sourceKey(source: ViewerSource): string {
  return source.kind === 'evidence'
    ? `e:${source.evidenceId}`
    : `r:${source.caseSlug}:${source.repoName}:${source.relPath}`
}

export function TextViewer({ source, focusStart, focusEnd, onClose }: Props): React.JSX.Element {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [derivedFrom, setDerivedFrom] = useState<string | null>(null)

  // adjust-state-during-render pattern: reset doc when the source/range changes
  const key = `${sourceKey(source)}:${focusStart}`
  const [lastKey, setLastKey] = useState(key)
  if (key !== lastKey) {
    setLastKey(key)
    setDoc(null)
    setError(null)
    setDerivedFrom(null)
  }

  useEffect(() => {
    if (source.kind === 'evidence') {
      void window.argus.evidence.read(source.evidenceId, focusStart).then((d) =>
        setDoc({
          title: `${d.caseSlug} / ${d.relPath}`,
          content: d.content,
          startLine: d.startLine,
          truncated: d.truncated,
          lang: langForPath(d.relPath).lang,
          ref: null,
          caseSlug: d.caseSlug,
          relPath: d.relPath,
          evidenceId: source.evidenceId
        })
      )
      return
    }
    void window.argus.workspaces
      .readText(source.caseSlug, source.repoName, source.relPath, focusStart)
      .then((r) => {
        if (!r.ok) {
          setError(
            r.reason === 'repo-not-linked'
              ? `repo "${source.repoName}" is not linked — link a checkout to view this file`
              : `file not found in ${source.repoName}`
          )
          return
        }
        setDoc({
          title: `${r.repoName} / ${r.relPath}`,
          content: r.content,
          startLine: r.startLine,
          truncated: r.truncated,
          lang: r.lang,
          ref: r.ref
        })
      })
    // sourceKey captures every field of source used above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, focusStart])

  useEffect(() => {
    if (doc) document.getElementById(`line-${focusStart}`)?.scrollIntoView({ block: 'center' })
  }, [doc, focusStart])

  // provenance: when this evidence was derived from a binary source, name it
  useEffect(() => {
    if (!doc || doc.caseSlug === undefined || doc.evidenceId === undefined) return
    const { caseSlug, evidenceId } = doc
    void window.argus.evidence.list(caseSlug).then((records) => {
      const rec = records.find((r) => r.id === evidenceId)
      const sourceId = rec?.meta.derivedFrom
      if (typeof sourceId !== 'number') return
      const src = records.find((r) => r.id === sourceId)
      setDerivedFrom(src?.relPath ?? `evidence #${sourceId}`)
    })
  }, [doc])

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="flex h-[80vh] w-[80vw] flex-col rounded-r4 border border-hair2 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hair px-3 py-2">
          <span className="flex items-center gap-2 font-mono text-sm text-ink">
            {doc ? doc.title : error ? 'Unavailable' : 'Loading…'}
            {doc?.ref && <Chip tone="neutral">@ {doc.ref}</Chip>}
            {derivedFrom && <Chip tone="neutral">derived from {derivedFrom}</Chip>}
            {doc?.truncated && <Chip tone="neutral">showing lines near {focusStart} only</Chip>}
          </span>
          <Btn variant="ghost" onClick={onClose}>
            Close
          </Btn>
        </div>
        {error ? (
          <div className="flex-1 p-4 text-sm text-mute">{error}</div>
        ) : doc ? (
          <HighlightedLines
            className="flex-1 p-3"
            lines={doc.content.split('\n')}
            startLine={doc.startLine}
            focusStart={focusStart}
            focusEnd={focusEnd}
            lang={doc.lang}
            lineIdPrefix="line-"
          />
        ) : (
          <pre className="flex-1 overflow-auto p-3 font-mono text-xs leading-5 text-dim" />
        )}
      </div>
    </div>
  )
}
