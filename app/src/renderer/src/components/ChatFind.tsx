import { useMemo, useState, useEffect, useRef } from 'react'
import { ArrowUp, ArrowDown, X } from 'lucide-react'
import type { TranscriptItem } from '../lib/agentStore'

/**
 * Item-granularity find overlay: matches are whole transcript items (user /
 * assistant text, case-insensitive substring), tool cards excluded. No
 * intra-markdown highlighting — ChatPane rings the matching/current items
 * instead (react-markdown re-processing is out of scope here).
 */
export function ChatFind({
  items,
  onNavigate,
  onClose,
  onMatchesChange
}: {
  items: TranscriptItem[]
  onNavigate: (itemIndex: number) => void
  onClose: () => void
  // optional: lets ChatPane ring *all* matching items (subtle ring), not just
  // the current one (strong ring) — ChatFind stays the source of truth for
  // "what matches" since it owns the query
  onMatchesChange?: (matchItemIndexes: number[]) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const matchIdx = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return items.reduce<number[]>((acc, item, i) => {
      if (item.kind !== 'tool' && item.text.toLowerCase().includes(q)) acc.push(i)
      return acc
    }, [])
  }, [items, query])

  // query changes invalidate the current match position — adjust-state-
  // during-render, keyed on the query/matchIdx identity like the reset
  // idioms elsewhere in this codebase
  const [lastQuery, setLastQuery] = useState(query)
  if (query !== lastQuery) {
    setLastQuery(query)
    setCurrent(0)
  }

  useEffect(() => {
    if (matchIdx.length === 0) return
    onNavigate(matchIdx[current % matchIdx.length])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, current, matchIdx])

  useEffect(() => {
    onMatchesChange?.(matchIdx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchIdx])

  function step(delta: number): void {
    if (matchIdx.length === 0) return
    setCurrent((c) => (c + delta + matchIdx.length) % matchIdx.length)
  }

  return (
    <div className="absolute right-3 top-11 z-20 flex items-center gap-2 rounded-r2 border border-hair bg-overlay px-2 py-1 shadow-lg">
      <input
        ref={inputRef}
        aria-label="Find in chat"
        placeholder="Find in chat"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
            return
          }
          if (e.key === 'Enter') {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
          }
        }}
        className="w-48 rounded-r1 bg-panel px-2 py-1 text-xs text-ink placeholder:text-mute focus:outline-none"
      />
      <span className="min-w-10 text-xs text-mute">
        {matchIdx.length === 0 ? '0/0' : `${(current % matchIdx.length) + 1}/${matchIdx.length}`}
      </span>
      <button
        type="button"
        aria-label="Previous match"
        title="Previous match"
        className="rounded-r1 px-1 text-xs text-mute transition-colors hover:bg-hair hover:text-ink"
        onClick={() => step(-1)}
      >
        <ArrowUp size={12} strokeWidth={1.5} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Next match"
        title="Next match"
        className="rounded-r1 px-1 text-xs text-mute transition-colors hover:bg-hair hover:text-ink"
        onClick={() => step(1)}
      >
        <ArrowDown size={12} strokeWidth={1.5} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Close find"
        title="Close find"
        className="rounded-r1 px-1 text-xs text-mute transition-colors hover:bg-hair hover:text-ink"
        onClick={onClose}
      >
        <X size={12} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  )
}
