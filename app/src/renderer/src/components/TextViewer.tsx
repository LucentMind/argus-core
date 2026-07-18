import { useEffect, useMemo, useRef, useState } from 'react'
import { Btn, Chip } from './ui'
import { HighlightedLines } from './HighlightedLines'
import { VirtualLines } from './VirtualLines'
import { ViewerFindBar, type FindState } from './ViewerFindBar'
import { LinePageCache } from '../lib/linePages'
import { textDocKey, type TextDocOpenOk, type TextDocSource } from '../../../shared/textdoc'

export type ViewerSource = TextDocSource

interface Props {
  source: ViewerSource
  focusStart: number
  focusEnd: number
  onClose: () => void
}

const EMPTY_FIND_STATE: FindState = {
  query: '',
  regex: false,
  caseSensitive: false,
  filterMode: false,
  hits: [],
  done: true,
  capped: false,
  scannedTo: 0,
  activeIdx: null
}

/** Streaming find/filter state for the large-file viewer. Debounces the query,
 *  tracks one live searchId per docKey (hub cancels the previous id on each new
 *  start), resets on source switch, and cancels the outstanding search on
 *  unmount. Next/prev binary-search the sorted hits and pull more on demand
 *  when the collected hits are capped. */
function useViewerSearch(
  source: TextDocSource,
  enabled: boolean
): {
  state: FindState
  setQuery: (q: string) => void
  toggle: (f: 'regex' | 'caseSensitive' | 'filterMode') => void
  next: (fromLine: number) => number | null
  prev: (fromLine: number) => number | null
} {
  const docKey = textDocKey(source)
  const [state, setState] = useState<FindState>(EMPTY_FIND_STATE)
  const [lastDocKey, setLastDocKey] = useState(docKey)
  const seq = useRef(0)
  const currentId = useRef('')

  // source switch: reset synchronously during render so no stale hits from the
  // previous doc ever paint against the new one (mirrors the doc/error reset above)
  if (docKey !== lastDocKey) {
    setLastDocKey(docKey)
    setState(EMPTY_FIND_STATE)
  }

  useEffect(() => {
    if (!enabled) return
    return window.argus.textdoc.onSearchHits((e) => {
      if (e.searchId !== currentId.current) return
      setState((s) => ({
        ...s,
        hits: [...s.hits, ...e.hits],
        done: e.done,
        capped: e.capped,
        scannedTo: e.scannedTo
      }))
    })
  }, [enabled])

  // invalidate the id ref as soon as the doc changes (before the debounced restart
  // below fires) so any straggler event from the old search's in-flight IPC is
  // dropped by the onSearchHits filter above, and cancel it on unmount too
  useEffect(() => {
    return () => {
      if (currentId.current) void window.argus.textdoc.cancelSearch(currentId.current)
      currentId.current = ''
    }
  }, [docKey])

  // debounce the query → (re)start search; clearing the query cancels in place
  useEffect(() => {
    if (!enabled) return
    const t = setTimeout(() => {
      const old = currentId.current
      if (old) void window.argus.textdoc.cancelSearch(old)
      currentId.current = ''
      setState((s) => ({
        ...s,
        hits: [],
        done: s.query === '',
        capped: false,
        scannedTo: 0,
        activeIdx: null
      }))
      if (state.query === '') return
      const id = `${docKey}:${++seq.current}`
      currentId.current = id
      void window.argus.textdoc.search(id, source, state.query, {
        regex: state.regex,
        caseSensitive: state.caseSensitive
      })
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.query, state.regex, state.caseSensitive, docKey, enabled])

  const setQuery = (q: string): void => setState((s) => ({ ...s, query: q }))
  const toggle = (f: 'regex' | 'caseSensitive' | 'filterMode'): void =>
    setState((s) => ({ ...s, [f]: !s[f] }))
  const requestMore = (): void => {
    if (!state.capped || !currentId.current) return
    void window.argus.textdoc.search(currentId.current, source, state.query, {
      regex: state.regex,
      caseSensitive: state.caseSensitive,
      fromLine: state.scannedTo + 1
    })
    setState((s) => ({ ...s, capped: false }))
  }
  // binary search helpers over the sorted hits array
  const next = (fromLine: number): number | null => {
    const h = state.hits
    let lo = 0
    let hi = h.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      h[m] > fromLine ? (hi = m) : (lo = m + 1)
    }
    if (lo >= h.length) {
      requestMore()
      return null
    }
    setState((s) => ({ ...s, activeIdx: lo }))
    return h[lo]
  }
  const prev = (fromLine: number): number | null => {
    const h = state.hits
    let lo = 0
    let hi = h.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      h[m] < fromLine ? (lo = m + 1) : (hi = m)
    }
    if (lo === 0) return null
    setState((s) => ({ ...s, activeIdx: lo - 1 }))
    return h[lo - 1]
  }
  return { state, setQuery, toggle, next, prev }
}

export function TextViewer({ source, focusStart, focusEnd, onClose }: Props): React.JSX.Element {
  const [doc, setDoc] = useState<TextDocOpenOk | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [derivedFrom, setDerivedFrom] = useState<string | null>(null)
  const [indexing, setIndexing] = useState<number | null>(null)
  const [scrollTarget, setScrollTarget] = useState<{ row: number; nonce: number } | null>(null)
  const [jump, setJump] = useState('')
  const nonce = useRef(0)
  const currentLine = useRef(Math.max(1, focusStart))
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
    setIndexing(null)
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
    // a source switch tears this effect down; drop any open() response that
    // resolves afterwards so the previous doc can't clobber the new one
    let stale = false
    const unProgress = window.argus.textdoc.onIndexProgress((p) => {
      if (p.key === docKey) setIndexing(p.fraction >= 1 ? null : p.fraction)
    })
    void window.argus.textdoc.open(source, focusStart).then((r) => {
      if (stale) return
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
    return () => {
      stale = true
      unProgress()
    }
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
    currentLine.current = clamped
    nonce.current++
    setScrollTarget({ row: clamped - 1, nonce: nonce.current })
  }

  const search = useViewerSearch(source, doc !== null && doc.whole === undefined)

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      onClick={onClose}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
          e.preventDefault()
          ;(document.querySelector('[data-viewer-find]') as HTMLInputElement | null)?.focus()
        }
      }}
      tabIndex={-1}
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
        {doc && doc.whole === undefined && (
          <ViewerFindBar
            state={search.state}
            onQueryChange={search.setQuery}
            onToggle={search.toggle}
            onNext={() => {
              const n = search.next(currentLine.current)
              if (n !== null) goToLine(n)
            }}
            onPrev={() => {
              const n = search.prev(currentLine.current)
              if (n !== null) goToLine(n)
            }}
          />
        )}
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
        ) : doc && search.state.filterMode ? (
          <VirtualLines
            className="flex-1 p-3"
            totalRows={search.state.hits.length}
            rowToLine={(r) => search.state.hits[r]}
            getLine={(n) => cache.getLine(n)}
            focusStart={focusStart}
            focusEnd={focusEnd}
            lang={doc.lang}
            scrollTarget={scrollTarget}
            onVisibleRows={(first, last) => {
              // v1: prefetch each visible hit's own page individually — adjacent
              // hits naturally coalesce onto the same page via LinePageCache
              for (let r = first; r <= last; r++) {
                const n = search.state.hits[r]
                if (n !== undefined) cache.prefetch(n, n)
              }
              const mid = search.state.hits[Math.floor((first + last) / 2)]
              if (mid !== undefined) currentLine.current = mid
            }}
            onRowClick={(n) => {
              search.toggle('filterMode')
              goToLine(n)
            }}
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
            onVisibleRows={(first, last) => {
              cache.prefetch(first - 500, last + 502)
              currentLine.current = Math.floor((first + last) / 2) + 1
            }}
          />
        ) : (
          <pre className="flex-1 overflow-auto p-3 font-mono text-xs leading-5 text-dim" />
        )}
      </div>
    </div>
  )
}
