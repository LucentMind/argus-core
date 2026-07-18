import { useEffect, useRef, useState } from 'react'
import { ensureLanguage, highlightLine, isRegistered } from '../lib/highlight'

export const ROW_H = 20 // px, matches text-xs leading-5
const OVERSCAN = 30

interface VirtualLinesProps {
  totalRows: number
  rowToLine: (row: number) => number
  getLine: (lineNo: number) => string | undefined
  focusStart: number | null
  focusEnd: number | null
  activeLine?: number | null
  lang: string | null
  scrollTarget: { row: number; nonce: number } | null
  onVisibleRows?: (firstRow: number, lastRow: number) => void
  onRowClick?: (lineNo: number) => void
  className?: string
}

/** Fixed-row-height virtual list over up to millions of lines. Only the
 *  viewport ± OVERSCAN rows exist in the DOM; content comes from getLine
 *  (undefined ⇒ skeleton row while the page loads). */
export function VirtualLines({
  totalRows,
  rowToLine,
  getLine,
  focusStart,
  focusEnd,
  activeLine,
  lang,
  scrollTarget,
  onVisibleRows,
  onRowClick,
  className = ''
}: VirtualLinesProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ first: 0, last: 60 })
  const [, bump] = useState(0)

  const canHighlight = lang !== null && isRegistered(lang)
  useEffect(() => {
    if (lang === null || isRegistered(lang)) return
    let alive = true
    void ensureLanguage(lang).then((ok) => {
      if (alive && ok) bump((n) => n + 1)
    })
    return () => {
      alive = false
    }
  }, [lang])

  const measure = (): void => {
    const el = ref.current
    if (!el) return
    const first = Math.max(0, Math.floor(el.scrollTop / ROW_H) - OVERSCAN)
    const last = Math.min(
      totalRows - 1,
      Math.ceil((el.scrollTop + el.clientHeight) / ROW_H) + OVERSCAN
    )
    setRange({ first, last })
    if (last >= first) onVisibleRows?.(first, last)
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(measure, [totalRows])

  // A programmatic scrollTop assignment fires an asynchronous `scroll` event in
  // real browsers (jsdom doesn't) — an echo of the measure() we already ran
  // synchronously below. Suppress exactly that echo, or it would re-fire
  // onVisibleRows after the parent has finished reacting to the programmatic
  // scroll (e.g. TextViewer's cursor restore) and clobber its state.
  const suppressEchoTop = useRef<number | null>(null)

  useEffect(() => {
    if (!scrollTarget || !ref.current) return
    const el = ref.current
    el.scrollTop = Math.max(0, scrollTarget.row * ROW_H - el.clientHeight / 2 + ROW_H / 2)
    measure()
    suppressEchoTop.current = el.scrollTop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTarget?.nonce])

  const onScroll = (): void => {
    const el = ref.current
    if (el && suppressEchoTop.current !== null && el.scrollTop === suppressEchoTop.current) {
      // the echo of our own assignment — range is already correct from the
      // synchronous measure(); a real user scroll changes scrollTop and falls through
      suppressEchoTop.current = null
      return
    }
    suppressEchoTop.current = null
    measure()
  }

  const rows: React.JSX.Element[] = []
  for (let r = range.first; r <= Math.min(range.last, totalRows - 1); r++) {
    const n = rowToLine(r)
    const line = getLine(n)
    const focused = focusStart !== null && n >= focusStart && n <= (focusEnd ?? focusStart)
    const isActive = activeLine != null && n === activeLine
    rows.push(
      <div
        key={r}
        data-vrow={r}
        {...(isActive ? { 'data-active-line': true } : {})}
        id={`line-${n}`}
        onClick={onRowClick ? () => onRowClick(n) : undefined}
        className={`absolute left-0 right-0 whitespace-pre ${
          isActive ? 'bg-hair text-ink' : focused ? 'bg-defect/20 text-ink' : ''
        }${onRowClick ? ' cursor-pointer hover:bg-hair/40' : ''}`}
        style={{ top: r * ROW_H, height: ROW_H }}
      >
        <span className="mr-3 inline-block w-14 select-none text-right text-mute">{n}</span>
        {line === undefined ? (
          <span className="text-mute">…</span>
        ) : canHighlight && lang ? (
          <span dangerouslySetInnerHTML={{ __html: highlightLine(line, lang) }} />
        ) : (
          <span>{line}</span>
        )}
      </div>
    )
  }

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className={`relative overflow-auto font-mono text-xs leading-5 text-dim ${className}`}
    >
      <div style={{ height: totalRows * ROW_H, position: 'relative' }}>{rows}</div>
    </div>
  )
}
