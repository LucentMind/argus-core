import { useEffect, useRef, useState } from 'react'
import { ensureLanguage, highlightLine, isRegistered } from '../lib/highlight'
import { maxSpacerPx } from '../lib/spacerCap'

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
  // `top` = absolute y within the spacer at which row `first` is painted. Under
  // the clamp it is always first * ROW_H; above it the rendered window is
  // pinned to the live scroll offset instead (see windowFor).
  const [range, setRange] = useState({ first: 0, last: 60, top: 0 })
  const [, bump] = useState(0)

  // Compressed only when the file is too tall for the engine; otherwise this is
  // the identity mapping and every formula below reduces to scrollTop = row * ROW_H.
  const spacerPx = Math.min(totalRows * ROW_H, maxSpacerPx())

  /** Rows the viewport covers at `scrollTop`, plus the paint origin for the
   *  first of them. Interpolates row-space against scroll-space so both ends
   *  are exact: scrollTop 0 → row 0, max scrollTop → last row at the bottom. */
  const windowFor = (
    scrollTop: number,
    clientHeight: number
  ): { first: number; last: number; top: number } => {
    const maxScroll = Math.max(0, spacerPx - clientHeight)
    const maxTopRow = Math.max(0, totalRows - clientHeight / ROW_H)
    const topRowExact = maxScroll > 0 ? Math.min(maxTopRow, (scrollTop / maxScroll) * maxTopRow) : 0
    const topRow = Math.floor(topRowExact)
    const first = Math.max(0, topRow - OVERSCAN)
    const last = Math.min(totalRows - 1, topRow + Math.ceil(clientHeight / ROW_H) + OVERSCAN)
    // keep the partially-scrolled row aligned with the viewport edge
    const top = scrollTop - (topRowExact - topRow) * ROW_H - (topRow - first) * ROW_H
    return { first, last, top }
  }

  /** Inverse of windowFor: the scrollTop that centres `row` in the viewport. */
  const scrollTopFor = (row: number, clientHeight: number): number => {
    const maxScroll = Math.max(0, spacerPx - clientHeight)
    const maxTopRow = Math.max(0, totalRows - clientHeight / ROW_H)
    if (maxScroll <= 0 || maxTopRow <= 0) return 0
    const targetTopRow = row - clientHeight / (2 * ROW_H) + 0.5
    return Math.max(0, Math.min(maxScroll, (targetTopRow / maxTopRow) * maxScroll))
  }

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
    const { first, last, top } = windowFor(el.scrollTop, el.clientHeight)
    setRange({ first, last, top })
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
    el.scrollTop = scrollTopFor(scrollTarget.row, el.clientHeight)
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
        style={{ top: range.top + (r - range.first) * ROW_H, height: ROW_H }}
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
      // Vertical padding is forced off, inline so it beats any caller class.
      // Padding above the spacer offsets every absolutely-positioned row by
      // that amount while contributing extra scrollable height the row
      // arithmetic below does not model — which clipped the final row in half.
      // Horizontal padding from `className` is unaffected.
      style={{ paddingTop: 0, paddingBottom: 0 }}
      className={`relative overflow-auto font-mono text-xs leading-5 text-dim ${className}`}
    >
      <div style={{ height: spacerPx, position: 'relative' }}>{rows}</div>
    </div>
  )
}
