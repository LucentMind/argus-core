import { useEffect, useRef, useState } from 'react'
import { Btn, Chip } from './ui'
import { HighlightedLines } from './HighlightedLines'
import { VirtualLines } from './VirtualLines'
import { ViewerFindBar, type FindBarState, type StreamState } from './ViewerFindBar'
import { LinePageCache } from '../lib/linePages'
import { textDocKey, type TextDocOpenOk, type TextDocSource } from '../../../shared/textdoc'

export type ViewerSource = TextDocSource

interface Props {
  source: ViewerSource
  focusStart: number
  focusEnd: number
  onClose: () => void
}

interface Cut {
  from: number
  to: number | null
}

/** Props shared by the normal and filter-mode VirtualLines branches below —
 *  they differ only in totalRows/rowToLine/onVisibleRows/onRowClick. */
function virtualLinesCommonProps(
  doc: TextDocOpenOk,
  focusStart: number,
  focusEnd: number,
  scrollTarget: { row: number; nonce: number } | null,
  getLine: (n: number) => string | undefined
): {
  className: string
  getLine: (n: number) => string | undefined
  focusStart: number
  focusEnd: number
  lang: string | null
  scrollTarget: { row: number; nonce: number } | null
} {
  return {
    className: 'flex-1 p-3',
    getLine,
    focusStart,
    focusEnd,
    lang: doc.lang,
    scrollTarget
  }
}

/** Greatest index in a sorted-ascending hits array whose value is ≤ `line`, or
 *  0 if none qualifies. Used both to locate a find-hit's row within the
 *  filter-hit list (exact match, guaranteed present by the subset invariant —
 *  this also tolerates the rare race where it isn't yet) and to locate the
 *  nearest filter row for an arbitrary jump-to-line target. */
function nearestAtOrBelow(hits: number[], line: number): number {
  let lo = 0
  let hi = hits.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    hits[m] <= line ? (lo = m + 1) : (hi = m)
  }
  return Math.max(0, lo - 1)
}

/** Exact-match index of `line` in sorted-ascending `hits`, or -1 when absent. */
function indexOfLine(hits: number[], line: number): number {
  const i = nearestAtOrBelow(hits, line)
  return hits[i] === line ? i : -1
}

const EMPTY_STREAM: StreamState = {
  query: '',
  regex: false,
  caseSensitive: false,
  hits: [],
  done: true,
  capped: false,
  scannedTo: 0
}

type StreamsState = Omit<FindBarState, 'cutFrom' | 'cutTo'>

const EMPTY_STREAMS_STATE: StreamsState = {
  filter: EMPTY_STREAM,
  find: EMPTY_STREAM,
  activeIdx: null
}

/** Streaming filter/find state for the large-file viewer, split across two hub
 *  channels (`flt`/`fnd`) so a filter query and a find query run — and are
 *  cancelled — independently (the hub only supersedes the previous id on the
 *  SAME channel). Debounces each query, tracks one live searchId per channel,
 *  resets on source switch, and cancels outstanding searches on unmount.
 *  Next/prev binary-search the sorted find hits and pull more on demand when
 *  the collected hits are capped — as does the filter stream, via requestMore. */
function useViewerStreams(
  source: TextDocSource,
  enabled: boolean,
  cut: Cut
): {
  state: StreamsState
  setQuery: (stream: 'filter' | 'find', q: string) => void
  toggle: (stream: 'filter' | 'find', flag: 'regex' | 'caseSensitive') => void
  setActive: (idx: number | null) => void
  next: (fromLine: number) => { line: number; idx: number } | null
  prev: (fromLine: number) => { line: number; idx: number } | null
} {
  const docKey = textDocKey(source)
  const [state, setState] = useState<StreamsState>(EMPTY_STREAMS_STATE)
  const [lastDocKey, setLastDocKey] = useState(docKey)
  const seq = useRef(0)
  // two plain string refs (not one object ref) — mirrors the pre-split hook's
  // proven `currentId` shape exactly, one per channel
  const fltId = useRef('')
  const fndId = useRef('')
  // the toLine ceiling the CURRENT fnd issue was scoped to (null = unbounded/
  // cut-EOF). When the filter stream is capped, fnd is deliberately truncated
  // at the filter frontier — the engine then legitimately reports done at that
  // artificial boundary, and the hits handler must rewrite it as capped so the
  // tail stays reachable via requestMore.
  const fndCeil = useRef<number | null>(null)
  // current cut, mirrored into a ref for the lifetime-scoped hits subscription
  const cutRef = useRef(cut)
  useEffect(() => {
    cutRef.current = cut
  })

  // source switch: reset synchronously during render so no stale hits from the
  // previous doc ever paint against the new one (mirrors the doc/error reset in
  // TextViewer). Both channel ids must be nulled here too — the [docKey] effect
  // cleanup below runs post-paint, and a straggler onSearchHits batch from the
  // OLD file arriving in that window would pass the stale-id check and land in
  // the NEW file's empty hits. Safe in render because the branch only runs on a
  // key change (idempotent across re-renders with the same docKey).
  if (docKey !== lastDocKey) {
    setLastDocKey(docKey)
    // deliberate ref access in render: both ids must be invalidated before this
    // very render's output can paint, and the branch is idempotent (key-change only)
    // eslint-disable-next-line react-hooks/refs
    const oldFlt = fltId.current
    // eslint-disable-next-line react-hooks/refs
    const oldFnd = fndId.current
    // eslint-disable-next-line react-hooks/refs
    fltId.current = ''
    // eslint-disable-next-line react-hooks/refs
    fndId.current = ''
    // eslint-disable-next-line react-hooks/refs
    fndCeil.current = null
    if (oldFlt) void window.argus.textdoc.cancelSearch(oldFlt)
    if (oldFnd) void window.argus.textdoc.cancelSearch(oldFnd)
    setState(EMPTY_STREAMS_STATE)
  }

  // subscribed for the component's whole lifetime (not gated on `enabled`): a brief
  // doc reload (e.g. re-focusing the same file at a different line) flips `enabled`
  // off and back on without touching the search itself, and unsubscribing during
  // that window would silently drop any in-flight hit batch. Staleness is instead
  // handled by the id-ref checks below, which are correct regardless of `enabled`.
  useEffect(() => {
    return window.argus.textdoc.onSearchHits((e) => {
      if (e.searchId === fltId.current) {
        setState((s) => ({
          ...s,
          filter: {
            ...s.filter,
            hits: [...s.filter.hits, ...e.hits],
            done: e.done,
            capped: e.capped,
            scannedTo: e.scannedTo
          }
        }))
      } else if (e.searchId === fndId.current) {
        // "done" from a truncation-scoped fnd issue only means "done up to the
        // filter frontier", not done with the file — rewrite it as capped so
        // the label offers more-on-demand and requestMore can resume past it.
        const ceil = fndCeil.current
        const truncated = e.done && ceil !== null && ceil < (cutRef.current.to ?? Infinity)
        setState((s) => ({
          ...s,
          find: {
            ...s.find,
            hits: [...s.find.hits, ...e.hits],
            done: truncated ? false : e.done,
            capped: truncated ? true : e.capped,
            scannedTo: truncated && ceil !== null ? ceil : e.scannedTo
          }
        }))
      }
    })
  }, [])

  // belt-and-braces: the render-phase reset above already nulls + cancels on a
  // docKey change (so this cleanup usually finds both ids === '' and does nothing);
  // its real job is the unmount path, where it cancels any still-active searches
  useEffect(() => {
    return () => {
      if (fltId.current) void window.argus.textdoc.cancelSearch(fltId.current)
      if (fndId.current) void window.argus.textdoc.cancelSearch(fndId.current)
      fltId.current = ''
      fndId.current = ''
    }
  }, [docKey])

  const filterActive = state.filter.query.trim() !== ''

  // debounce the filter query → (re)start the flt channel; clearing it cancels in place.
  // Deliberately NOT keyed on `enabled` — see the fnd effect below for the rationale.
  useEffect(() => {
    if (!enabled) return
    const t = setTimeout(() => {
      const old = fltId.current
      if (old) void window.argus.textdoc.cancelSearch(old)
      fltId.current = ''
      const q = state.filter.query.trim()
      setState((s) => ({
        ...s,
        filter: { ...s.filter, hits: [], done: q === '', capped: false, scannedTo: 0 },
        activeIdx: null
      }))
      if (q === '') return
      const id = `${docKey}:flt:${++seq.current}`
      fltId.current = id
      void window.argus.textdoc.search(id, source, state.filter.query, {
        regex: state.filter.regex,
        caseSensitive: state.filter.caseSensitive,
        fromLine: cut.from,
        toLine: cut.to ?? undefined
      })
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.filter.query, state.filter.regex, state.filter.caseSensitive, cut.from, cut.to, docKey])

  // debounce the find query → (re)start the fnd channel. Also restarts when the
  // FILTER changes (a filter change narrows/widens what `find` can match).
  // Deliberately NOT keyed on `enabled`: the find bar only exists (so these
  // queries can only change) while enabled is true, so a bare enabled-flip
  // (e.g. re-focusing the same doc at a different line, which briefly nulls
  // `doc`) must not restart a running or completed search — the `enabled`
  // check below just guards the IPC call itself.
  useEffect(() => {
    if (!enabled) return
    const t = setTimeout(() => {
      const old = fndId.current
      if (old) void window.argus.textdoc.cancelSearch(old)
      fndId.current = ''
      const q = state.find.query.trim()
      setState((s) => ({
        ...s,
        find: { ...s.find, hits: [], done: q === '', capped: false, scannedTo: 0 },
        activeIdx: null
      }))
      if (q === '') {
        fndCeil.current = null
        return
      }
      const id = `${docKey}:fnd:${++seq.current}`
      fndId.current = id
      // while the filter is still capped, don't let `find` scan past what the
      // filter has established as valid — this keeps the filtered view (row
      // space = filter.hits) and find's hits in sync. Record the ceiling this
      // issue is scoped to so the hits handler can tell truncation-done apart
      // from genuinely done (null = unbounded/cut-EOF; always finite otherwise).
      const rawCeil =
        filterActive && state.filter.capped
          ? Math.min(cut.to ?? Infinity, state.filter.scannedTo)
          : (cut.to ?? null)
      const ceil = rawCeil !== null && Number.isFinite(rawCeil) ? rawCeil : null
      fndCeil.current = ceil
      void window.argus.textdoc.search(id, source, state.find.query, {
        regex: state.find.regex,
        caseSensitive: state.find.caseSensitive,
        fromLine: cut.from,
        toLine: ceil ?? undefined,
        filter: filterActive
          ? {
              query: state.filter.query,
              regex: state.filter.regex,
              caseSensitive: state.filter.caseSensitive
            }
          : undefined
      })
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.find.query,
    state.find.regex,
    state.find.caseSensitive,
    state.filter.query,
    state.filter.regex,
    state.filter.caseSensitive,
    cut.from,
    cut.to,
    docKey
  ])

  const setQuery = (stream: 'filter' | 'find', q: string): void =>
    setState((s) => ({ ...s, [stream]: { ...s[stream], query: q } }))
  const toggle = (stream: 'filter' | 'find', flag: 'regex' | 'caseSensitive'): void =>
    setState((s) => ({ ...s, [stream]: { ...s[stream], [flag]: !s[stream][flag] } }))
  const setActive = (idx: number | null): void => setState((s) => ({ ...s, activeIdx: idx }))

  // Called by next() when the collected find hits are exhausted. Re-issues the
  // CURRENT fnd id from where it left off (same searchId — the hub treats this
  // as a continuation, not a new search) and, when the filter stream is ALSO
  // capped, separately re-issues the current flt id so the filtered view can
  // keep growing too (spec's both-streams rule). fnd's `capped` may be either
  // the engine's own cap or the truncation rewrite from the hits handler —
  // both resume the same way, with the ceiling recomputed from the CURRENT
  // filter state, so repeated next-past-end presses converge: each press
  // extends the filter frontier and lets find follow it.
  const requestMore = (): void => {
    if (state.find.capped && fndId.current) {
      const rawCeil =
        filterActive && state.filter.capped
          ? Math.min(cut.to ?? Infinity, state.filter.scannedTo)
          : (cut.to ?? null)
      const ceil = rawCeil !== null && Number.isFinite(rawCeil) ? rawCeil : null
      fndCeil.current = ceil
      void window.argus.textdoc.search(fndId.current, source, state.find.query, {
        regex: state.find.regex,
        caseSensitive: state.find.caseSensitive,
        fromLine: state.find.scannedTo + 1,
        toLine: ceil ?? undefined,
        filter: filterActive
          ? {
              query: state.filter.query,
              regex: state.filter.regex,
              caseSensitive: state.filter.caseSensitive
            }
          : undefined
      })
      setState((s) => ({ ...s, find: { ...s.find, capped: false } }))
    }
    if (state.filter.capped && fltId.current) {
      void window.argus.textdoc.search(fltId.current, source, state.filter.query, {
        regex: state.filter.regex,
        caseSensitive: state.filter.caseSensitive,
        fromLine: state.filter.scannedTo + 1,
        toLine: cut.to ?? undefined
      })
      setState((s) => ({ ...s, filter: { ...s.filter, capped: false } }))
    }
  }

  // Next/prev cursor: the ACTIVE MATCH is the cursor once one exists — each
  // press advances exactly one hit. The caller-supplied viewport line only
  // seeds the first jump (binary search over the sorted hits). Never derive
  // the cursor from the viewport midpoint on subsequent presses: it includes
  // overscan rows, and in the filtered view a short list pins it to the list
  // centre, which trapped next/prev in a handful of entries.
  // Return both the file line AND its index into `find.hits` — the filtered
  // view's VirtualLines is indexed by filter-hit-index, not find-hit-index, so
  // callers translate via nearestAtOrBelow(filter.hits, line).
  const next = (fromLine: number): { line: number; idx: number } | null => {
    const h = state.find.hits
    let idx: number
    if (state.activeIdx !== null) {
      idx = state.activeIdx + 1
    } else {
      let lo = 0
      let hi = h.length
      while (lo < hi) {
        const m = (lo + hi) >> 1
        h[m] > fromLine ? (hi = m) : (lo = m + 1)
      }
      idx = lo
    }
    if (idx >= h.length) {
      requestMore()
      return null
    }
    setState((s) => ({ ...s, activeIdx: idx }))
    return { line: h[idx], idx }
  }
  const prev = (fromLine: number): { line: number; idx: number } | null => {
    const h = state.find.hits
    let idx: number
    if (state.activeIdx !== null) {
      idx = state.activeIdx - 1
    } else {
      let lo = 0
      let hi = h.length
      while (lo < hi) {
        const m = (lo + hi) >> 1
        h[m] < fromLine ? (lo = m + 1) : (hi = m)
      }
      idx = lo - 1
    }
    if (idx < 0) return null
    setState((s) => ({ ...s, activeIdx: idx }))
    return { line: h[idx], idx }
  }
  return { state, setQuery, toggle, setActive, next, prev }
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

  // cut range: raw strings so the inputs can hold transient non-numeric text;
  // parsed+clamped into `cut` below. Reset on a docKey change only (not on a
  // bare focusStart change) — same rationale as the search streams' own reset:
  // re-focusing the same file at a different line must not disturb an active
  // cut/filter/find session.
  const [cutFrom, setCutFrom] = useState('')
  const [cutTo, setCutTo] = useState('')
  const [lastSearchDocKey, setLastSearchDocKey] = useState(docKey)
  if (docKey !== lastSearchDocKey) {
    setLastSearchDocKey(docKey)
    setCutFrom('')
    setCutTo('')
  }

  const cutFromN = (() => {
    const n = parseInt(cutFrom, 10)
    // constraint is 1..totalLines — clamp both ends (upper only once doc is known)
    return Number.isFinite(n) && n >= 1 ? Math.min(n, doc?.totalLines ?? n) : 1
  })()
  const cutToRaw = (() => {
    const n = parseInt(cutTo, 10)
    return Number.isFinite(n) ? n : null
  })()
  // reversed range (to < from) collapses to empty, not clamped-to-from
  const cut: Cut = {
    from: cutFromN,
    to: cutToRaw !== null && cutToRaw < cutFromN ? cutFromN - 1 : cutToRaw
  }

  // The page cache is a disposable resource, so the effect that disposes it must
  // also OWN it. Creating it in useMemo breaks under StrictMode's dev-only
  // setup→cleanup→setup mount cycle: cleanup would dispose the memoized instance,
  // and the second setup would reuse it dead — every page fetch silently dropped.
  // Held in state (not a ref) because rows read it during render; adoption happens
  // from a microtask per the repo's promise-callback set-state-in-effect idiom.
  const [cache, setCache] = useState<LinePageCache | null>(null)
  useEffect(() => {
    const c = new LinePageCache((from, to) => window.argus.textdoc.lines(source, from, to))
    const un = c.subscribe(() => bump((n) => n + 1))
    void Promise.resolve().then(() => setCache(c))
    return () => {
      un()
      c.dispose()
    }
    // source identity is docKey (fresh object literal per parent render)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey])
  const getCachedLine = (n: number): string | undefined => cache?.getLine(n)

  useEffect(() => {
    // a source switch tears this effect down; drop any open() response that
    // resolves afterwards so the previous doc can't clobber the new one
    let stale = false
    const unProgress = window.argus.textdoc.onIndexProgress((p) => {
      if (p.key === docKey) setIndexing(p.fraction >= 1 ? null : p.fraction)
    })
    void window.argus.textdoc.open(source).then((r) => {
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
        // clamp a stale citation beyond EOF to the last line (the header shows a
        // notice chip for this case — see staleFocus below)
        setScrollTarget({
          row: Math.max(0, Math.min(focusStart, r.totalLines) - 1),
          nonce: nonce.current
        })
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

  const clampToCut = (n: number): number => {
    const lo = cut.from
    const hi = cut.to ?? (doc ? doc.totalLines : lo)
    return Math.min(Math.max(lo, n), Math.max(lo, hi))
  }

  const goToLine = (n: number): void => {
    if (!doc) return
    const clamped = clampToCut(n)
    currentLine.current = clamped
    nonce.current++
    setScrollTarget({ row: clamped - cut.from, nonce: nonce.current })
  }

  const search = useViewerStreams(source, doc !== null && doc.whole === undefined, cut)
  const filterActive = search.state.filter.query.trim() !== ''
  const activeLine =
    search.state.activeIdx !== null
      ? (search.state.find.hits[search.state.activeIdx] ?? null)
      : null

  // Find next/prev jumps to a hit. In the filtered view, VirtualLines' row
  // space is filter-hit-INDEX space (rowToLine = filter.hits[r]), not
  // file-line space — so scroll to the hit's index within filter.hits (the
  // subset invariant guarantees the find hit is also a filter hit). Out of the
  // filtered view, goToLine (file-line space, cut-relative) is correct as-is.
  const jumpToHit = (hit: { line: number; idx: number } | null): void => {
    if (hit === null) return
    if (filterActive) {
      currentLine.current = hit.line
      nonce.current++
      setScrollTarget({
        row: nearestAtOrBelow(search.state.filter.hits, hit.line),
        nonce: nonce.current
      })
    } else {
      goToLine(hit.line)
    }
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      onClick={onClose}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault()
          // stop the native event from reaching ChatPane's window-level Ctrl/Cmd+F
          // listener underneath this modal (it stays mounted while the viewer is open)
          e.stopPropagation()
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
            {doc && doc.whole === undefined && focusStart > doc.totalLines && (
              <Chip tone="danger">
                line {focusStart} does not exist — the file ends at line {doc.totalLines}
              </Chip>
            )}
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
                    if (Number.isFinite(n)) {
                      if (filterActive) {
                        // jump-to-line stays filtered — scroll to the nearest
                        // filter row at-or-below the (cut-clamped) target line,
                        // without touching the filter itself
                        const clamped = clampToCut(n)
                        currentLine.current = clamped
                        nonce.current++
                        setScrollTarget({
                          row: nearestAtOrBelow(search.state.filter.hits, clamped),
                          nonce: nonce.current
                        })
                      } else {
                        goToLine(n)
                      }
                    }
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
            state={{ ...search.state, cutFrom, cutTo }}
            onQueryChange={search.setQuery}
            onToggle={search.toggle}
            onCutChange={(which, value) => (which === 'from' ? setCutFrom(value) : setCutTo(value))}
            onNext={() => jumpToHit(search.next(currentLine.current))}
            onPrev={() => jumpToHit(search.prev(currentLine.current))}
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
        ) : doc && filterActive ? (
          <VirtualLines
            {...virtualLinesCommonProps(doc, focusStart, focusEnd, scrollTarget, getCachedLine)}
            activeLine={activeLine}
            totalRows={search.state.filter.hits.length}
            rowToLine={(r) => search.state.filter.hits[r]}
            onVisibleRows={(first, last) => {
              // v1: prefetch each visible hit's own page individually — adjacent
              // hits naturally coalesce onto the same page via LinePageCache
              for (let r = first; r <= last; r++) {
                const n = search.state.filter.hits[r]
                if (n !== undefined) cache?.prefetch(n, n)
              }
              // seed next/prev from the top of the window, not its midpoint —
              // the midpoint (overscan-included) pins to the list centre on
              // short filtered lists and trapped the cursor (see useViewerStreams)
              const top = search.state.filter.hits[first]
              if (top !== undefined) currentLine.current = top
            }}
            onRowClick={(n) => {
              // the filtered view is input-driven — a row click no longer exits
              // it. It just moves the active line, marking the row as the
              // active find match when it happens to be one.
              currentLine.current = n
              const idx = indexOfLine(search.state.find.hits, n)
              search.setActive(idx >= 0 ? idx : null)
            }}
          />
        ) : doc ? (
          <VirtualLines
            {...virtualLinesCommonProps(doc, focusStart, focusEnd, scrollTarget, getCachedLine)}
            activeLine={activeLine}
            totalRows={Math.max(0, (cut.to ?? doc.totalLines) - cut.from + 1)}
            rowToLine={(r) => r + cut.from}
            onVisibleRows={(first, last) => {
              const loLine = Math.max(cut.from, first + cut.from - 500)
              const hiLineRaw = last + cut.from + 502
              const hiLine = cut.to !== null ? Math.min(hiLineRaw, cut.to) : hiLineRaw
              cache?.prefetch(loLine, hiLine)
              // top-of-window seed; only the first next/prev press reads this
              currentLine.current = first + cut.from
            }}
          />
        ) : (
          <pre className="flex-1 overflow-auto p-3 font-mono text-xs leading-5 text-dim" />
        )}
      </div>
    </div>
  )
}
