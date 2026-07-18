import { Btn } from './ui'

export interface FindState {
  query: string
  regex: boolean
  caseSensitive: boolean
  filterMode: boolean
  hits: number[]
  done: boolean
  capped: boolean
  scannedTo: number
  activeIdx: number | null
}

interface ViewerFindBarProps {
  state: FindState
  onQueryChange: (q: string) => void
  onToggle: (flag: 'regex' | 'caseSensitive' | 'filterMode') => void
  onNext: () => void
  onPrev: () => void
}

/** Streaming-search find bar for the large-file viewer. Purely controlled —
 *  all state (query, hits, toggles) lives in the caller's useViewerSearch hook. */
export function ViewerFindBar({
  state,
  onQueryChange,
  onToggle,
  onNext,
  onPrev
}: ViewerFindBarProps): React.JSX.Element {
  const count = state.hits.length
  const label =
    state.query === ''
      ? ''
      : state.capped
        ? `${count.toLocaleString('en-US')} matches — more on demand`
        : state.done
          ? state.activeIdx !== null
            ? `${state.activeIdx + 1} / ${count.toLocaleString('en-US')} matches`
            : `${count.toLocaleString('en-US')} matches`
          : `${count.toLocaleString('en-US')}… searching`
  return (
    <div className="flex items-center gap-2 border-b border-hair px-3 py-1.5">
      <input
        data-viewer-find
        className="w-64 rounded border border-hair bg-transparent px-2 py-0.5 font-mono text-xs text-ink"
        placeholder="find in file"
        value={state.query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ;(e.shiftKey ? onPrev : onNext)()
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            onQueryChange('')
          }
        }}
      />
      <button
        title="regex"
        onClick={() => onToggle('regex')}
        className={`rounded px-1.5 font-mono text-xs ${state.regex ? 'bg-hair text-ink' : 'text-mute'}`}
      >
        .*
      </button>
      <button
        title="match case"
        onClick={() => onToggle('caseSensitive')}
        className={`rounded px-1.5 font-mono text-xs ${state.caseSensitive ? 'bg-hair text-ink' : 'text-mute'}`}
      >
        Aa
      </button>
      <button
        title="filter to matches"
        onClick={() => onToggle('filterMode')}
        className={`rounded px-1.5 font-mono text-xs ${state.filterMode ? 'bg-hair text-ink' : 'text-mute'}`}
      >
        ☰
      </button>
      <span className="text-xs text-mute">{label}</span>
      <span className="ml-auto flex gap-1">
        <Btn variant="ghost" onClick={onPrev}>
          ↑
        </Btn>
        <Btn variant="ghost" onClick={onNext}>
          ↓
        </Btn>
      </span>
    </div>
  )
}
