import { useEffect, useMemo, useRef, useState } from 'react'
import { Btn, Chip } from './ui'
import { HighlightedLines } from './HighlightedLines'
import { VirtualLines } from './VirtualLines'
import { LinePageCache } from '../lib/linePages'
import { textDocKey, type TextDocOpenOk, type TextDocSource } from '../../../shared/textdoc'

export type ViewerSource = TextDocSource

interface Props {
  source: ViewerSource
  focusStart: number
  focusEnd: number
  onClose: () => void
}

export function TextViewer({ source, focusStart, focusEnd, onClose }: Props): React.JSX.Element {
  const [doc, setDoc] = useState<TextDocOpenOk | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [derivedFrom, setDerivedFrom] = useState<string | null>(null)
  const [indexing, setIndexing] = useState<number | null>(null)
  const [scrollTarget, setScrollTarget] = useState<{ row: number; nonce: number } | null>(null)
  const [jump, setJump] = useState('')
  const nonce = useRef(0)
  const [, bump] = useState(0)

  const docKey = textDocKey(source)
  const key = `${docKey}:${focusStart}`
  const [lastKey, setLastKey] = useState(key)
  if (key !== lastKey) {
    setLastKey(key)
    setDoc(null)
    setError(null)
    setDerivedFrom(null)
    setScrollTarget(null)
  }

  const cache = useMemo(
    () => new LinePageCache((from, to) => window.argus.textdoc.lines(source, from, to)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docKey]
  )
  useEffect(() => {
    const un = cache.subscribe(() => bump((n) => n + 1))
    return () => {
      un()
      cache.dispose()
    }
  }, [cache])

  useEffect(() => {
    const unProgress = window.argus.textdoc.onIndexProgress((p) => {
      if (p.key === docKey) setIndexing(p.fraction >= 1 ? null : p.fraction)
    })
    void window.argus.textdoc.open(source, focusStart).then((r) => {
      if (!r.ok) {
        setError(
          r.reason === 'repo-not-linked'
            ? 'repo is not linked — link a checkout to view this file'
            : 'file not found'
        )
        return
      }
      setDoc(r)
      setIndexing(null)
      if (r.whole === undefined) {
        nonce.current++
        setScrollTarget({ row: Math.max(0, focusStart - 1), nonce: nonce.current })
      }
    })
    return unProgress
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // small-file path: scroll the focus line into view (legacy behavior)
  useEffect(() => {
    if (doc?.whole !== undefined)
      document.getElementById(`line-${focusStart}`)?.scrollIntoView({ block: 'center' })
  }, [doc, focusStart])

  // provenance chip: derived-from lookup (evidence only) — unchanged logic
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

  const goToLine = (n: number): void => {
    if (!doc) return
    const clamped = Math.min(Math.max(1, n), doc.totalLines)
    nonce.current++
    setScrollTarget({ row: clamped - 1, nonce: nonce.current })
  }

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
            {doc && <Chip tone="neutral">{doc.totalLines.toLocaleString('en-US')} lines</Chip>}
            {indexing !== null && (
              <Chip tone="neutral">indexing… {Math.round(indexing * 100)}%</Chip>
            )}
          </span>
          <span className="flex items-center gap-2">
            {doc && doc.whole === undefined && (
              <input
                className="w-28 rounded border border-hair bg-transparent px-2 py-0.5 font-mono text-xs text-ink"
                placeholder="go to line"
                value={jump}
                onChange={(e) => setJump(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const n = parseInt(jump, 10)
                    if (Number.isFinite(n)) goToLine(n)
                  }
                }}
              />
            )}
            <Btn variant="ghost" onClick={onClose}>
              Close
            </Btn>
          </span>
        </div>
        {error ? (
          <div className="flex-1 p-4 text-sm text-mute">{error}</div>
        ) : doc?.whole !== undefined ? (
          <HighlightedLines
            className="flex-1 p-3"
            lines={doc.whole.split('\n')}
            startLine={1}
            focusStart={focusStart}
            focusEnd={focusEnd}
            lang={doc.lang}
            lineIdPrefix="line-"
          />
        ) : doc ? (
          <VirtualLines
            className="flex-1 p-3"
            totalRows={doc.totalLines}
            rowToLine={(r) => r + 1}
            getLine={(n) => cache.getLine(n)}
            focusStart={focusStart}
            focusEnd={focusEnd}
            lang={doc.lang}
            scrollTarget={scrollTarget}
            onVisibleRows={(first, last) => cache.prefetch(first - 500, last + 502)}
          />
        ) : (
          <pre className="flex-1 overflow-auto p-3 font-mono text-xs leading-5 text-dim" />
        )}
      </div>
    </div>
  )
}
