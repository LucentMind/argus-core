import { Btn } from './ui'
import { transientFieldEscape } from '../lib/escapeLayer'

export interface StreamState {
  query: string
  regex: boolean
  caseSensitive: boolean
  hits: number[]
  done: boolean
  capped: boolean
  scannedTo: number
}

export interface FindBarState {
  filter: StreamState
  find: StreamState
  activeIdx: number | null
  cutFrom: string // raw input, '' = unbounded
  cutTo: string
}

interface ViewerFindBarProps {
  state: FindBarState
  onQueryChange: (stream: 'filter' | 'find', q: string) => void
  onToggle: (stream: 'filter' | 'find', flag: 'regex' | 'caseSensitive') => void
  onCutChange: (which: 'from' | 'to', value: string) => void
  onNext: () => void
  onPrev: () => void
}

const SQ = 'grid h-6 w-6 place-items-center rounded font-mono text-xs'
const tog = (on: boolean): string => `${SQ} ${on ? 'bg-hair text-ink' : 'text-mute'}`

/** Match-count / progress label. Precedence: capped (there's more to fetch on
 *  demand) beats done (final count, possibly with the active position) beats
 *  in-flight (still streaming). Empty query shows nothing. */
function findLabel(find: StreamState, activeIdx: number | null): string {
  if (find.query === '') return ''
  const count = find.hits.length.toLocaleString('en-US')
  if (find.capped) return `${count} matches — more on demand`
  if (!find.done) return `${count}… searching`
  if (activeIdx !== null) return `${activeIdx + 1} / ${count} matches`
  return `${count} matches`
}

/** Streaming-search find bar for the large-file viewer. Purely controlled —
 *  all state (queries, hits, toggles, cut bounds) lives in the caller's
 *  useViewerSearch hook. Separate filter and find inputs each drive their own
 *  StreamState; cut inputs bound which lines are loaded. */
export function ViewerFindBar({
  state,
  onQueryChange,
  onToggle,
  onCutChange,
  onNext,
  onPrev
}: ViewerFindBarProps): React.JSX.Element {
  const { filter, find } = state
  return (
    <div className="flex items-center gap-2 border-b border-hair px-3 py-1.5">
      <input
        data-viewer-filter
        className="w-48 rounded border border-hair bg-transparent px-2 py-0.5 font-mono text-xs text-ink"
        placeholder="filter lines"
        value={filter.query}
        onChange={(e) => onQueryChange('filter', e.target.value)}
        onKeyDown={(e) =>
          transientFieldEscape(e, state.filter.query === '', () => onQueryChange('filter', ''))
        }
      />
      <button
        title="filter regex"
        onClick={() => onToggle('filter', 'regex')}
        className={tog(filter.regex)}
      >
        .*
      </button>
      <button
        title="filter match case"
        onClick={() => onToggle('filter', 'caseSensitive')}
        className={tog(filter.caseSensitive)}
      >
        Aa
      </button>
      {filter.query !== '' && (
        <span className="text-xs text-mute">
          {filter.hits.length.toLocaleString('en-US')} filtered
        </span>
      )}
      <input
        data-viewer-find
        className="w-48 rounded border border-hair bg-transparent px-2 py-0.5 font-mono text-xs text-ink"
        placeholder="find in file"
        value={find.query}
        onChange={(e) => onQueryChange('find', e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.shiftKey ? onPrev : onNext)()
          else if (e.key === 'Escape') {
            e.stopPropagation()
            transientFieldEscape(e, state.find.query === '', () => onQueryChange('find', ''))
          }
        }}
      />
      <button title="regex" onClick={() => onToggle('find', 'regex')} className={tog(find.regex)}>
        .*
      </button>
      <button
        title="match case"
        onClick={() => onToggle('find', 'caseSensitive')}
        className={tog(find.caseSensitive)}
      >
        Aa
      </button>
      <span className="text-xs text-mute">{findLabel(find, state.activeIdx)}</span>
      <span className="ml-auto flex items-center gap-1">
        <input
          className="w-16 rounded border border-hair bg-transparent px-2 py-0.5 font-mono text-xs text-ink"
          placeholder="from"
          title="cut start line"
          value={state.cutFrom}
          onChange={(e) => onCutChange('from', e.target.value)}
          onKeyDown={(e) =>
            transientFieldEscape(e, state.cutFrom === '', () => onCutChange('from', ''))
          }
        />
        <input
          className="w-16 rounded border border-hair bg-transparent px-2 py-0.5 font-mono text-xs text-ink"
          placeholder="to"
          title="cut end line"
          value={state.cutTo}
          onChange={(e) => onCutChange('to', e.target.value)}
          onKeyDown={(e) =>
            transientFieldEscape(e, state.cutTo === '', () => onCutChange('to', ''))
          }
        />
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
