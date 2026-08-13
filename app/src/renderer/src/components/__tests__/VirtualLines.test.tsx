// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { VirtualLines, ROW_H } from '../VirtualLines'
import { __setMaxSpacerPxForTests } from '../../lib/spacerCap'

function setup(over: Partial<Parameters<typeof VirtualLines>[0]> = {}): ReturnType<
  typeof render
> & {
  scroller: HTMLElement
  props: Parameters<typeof VirtualLines>[0]
} {
  const props = {
    totalRows: 100_000,
    rowToLine: (r: number) => r + 1,
    getLine: (n: number) => (n <= 50_000 ? `line ${n}` : undefined),
    focusStart: null as number | null,
    focusEnd: null as number | null,
    activeLine: null as number | null,
    lang: null,
    scrollTarget: null,
    ...over
  }
  const utils = render(<VirtualLines {...props} />)
  const scroller = utils.container.firstElementChild as HTMLElement
  // jsdom has no layout: fix the viewport height
  Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true })
  return { ...utils, scroller, props }
}

describe('VirtualLines', () => {
  it('renders only the visible window plus overscan, inside a full-height spacer', () => {
    const { scroller, container } = setup()
    fireEvent.scroll(scroller) // trigger initial measure
    const spacer = scroller.firstElementChild as HTMLElement
    expect(spacer.style.height).toBe(`${100_000 * ROW_H}px`)
    const rows = container.querySelectorAll('[data-vrow]')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(200) // never the whole file
  })

  it('renders rows at the scrolled position with ids and content', () => {
    const { scroller, container } = setup()
    scroller.scrollTop = 1000 * ROW_H
    fireEvent.scroll(scroller)
    expect(container.querySelector('#line-1001')).toHaveTextContent('line 1001')
  })

  it('highlights the focus range and shows skeletons for unloaded lines', () => {
    const { scroller, container } = setup({ focusStart: 1001, focusEnd: 1002 })
    scroller.scrollTop = 1000 * ROW_H
    fireEvent.scroll(scroller)
    expect(container.querySelector('#line-1001')?.className).toContain('bg-defect/20')
    expect(container.querySelector('#line-1000')?.className).not.toContain('bg-defect/20')
    const { scroller: s2, container: c2 } = setup()
    s2.scrollTop = 60_000 * ROW_H
    fireEvent.scroll(s2)
    expect(c2.querySelector('#line-60001')).toHaveTextContent('…')
  })

  it('maps rows through rowToLine (filter mode) and reports clicks', () => {
    const onRowClick = vi.fn()
    const hits = [5, 900, 42_000]
    const { container } = setup({
      totalRows: 3,
      rowToLine: (r) => hits[r],
      onRowClick
    })
    expect(container.querySelector('#line-42000')).toBeInTheDocument()
    fireEvent.click(container.querySelector('#line-900')!)
    expect(onRowClick).toHaveBeenCalledWith(900)
  })

  it('scrolls to scrollTarget row centered', () => {
    const { scroller, rerender, props } = setup()
    rerender(<VirtualLines {...props} scrollTarget={{ row: 5000, nonce: 1 }} />)
    expect(scroller.scrollTop).toBe(5000 * ROW_H - 200 + ROW_H / 2)
  })

  it('suppresses the echo scroll event of its own programmatic scroll', () => {
    // real browsers fire an async `scroll` event when scrollTop is assigned;
    // that echo must not re-fire onVisibleRows (parents react to the
    // programmatic scroll once — see TextViewer's cursor restore)
    const onVisibleRows = vi.fn()
    const { scroller, rerender, props } = setup({ onVisibleRows })
    rerender(
      <VirtualLines
        {...props}
        onVisibleRows={onVisibleRows}
        scrollTarget={{ row: 5000, nonce: 1 }}
      />
    )
    const callsAfterProgrammatic = onVisibleRows.mock.calls.length
    // the echo: a scroll event with the scrollTop the component itself set
    fireEvent.scroll(scroller)
    expect(onVisibleRows.mock.calls.length).toBe(callsAfterProgrammatic)
    // a genuine user scroll (scrollTop changed) fires normally
    scroller.scrollTop = 7000 * ROW_H
    fireEvent.scroll(scroller)
    expect(onVisibleRows.mock.calls.length).toBe(callsAfterProgrammatic + 1)
  })

  it('marks the active line distinctly, overriding the focus highlight', () => {
    const { scroller, container } = setup({ focusStart: 1001, focusEnd: 1005, activeLine: 1003 })
    scroller.scrollTop = 1000 * ROW_H
    fireEvent.scroll(scroller)
    const active = container.querySelector('[data-active-line]')
    expect(active).toBe(container.querySelector('#line-1003'))
    expect(active!.className).toContain('bg-hair')
    expect(active!.className).not.toContain('bg-defect/20')
    expect(container.querySelector('#line-1002')!.className).toContain('bg-defect/20')
    expect(container.querySelectorAll('[data-active-line]')).toHaveLength(1)
  })
})

// Chromium clamps any layout box at ~33.5M device px, so a spacer sized
// totalRows * ROW_H silently stops growing on very large files and every row
// past the clamp becomes unreachable — a 200MB logcat at 220% display scaling
// dead-ended around line 762,600. The spacer must stay under the engine's real
// ceiling, with scroll position mapped through the resulting compression.
describe('VirtualLines beyond the engine spacer clamp', () => {
  const CAP = 1_000_000 // stand-in for the measured browser ceiling
  const HUGE = 2_000_000 // rows; 40M px unclamped, 40x over CAP

  afterEach(() => __setMaxSpacerPxForTests(null))

  function huge(over: Partial<Parameters<typeof VirtualLines>[0]> = {}): {
    scroller: HTMLElement
    container: HTMLElement
    rerender: ReturnType<typeof render>['rerender']
    props: Parameters<typeof VirtualLines>[0]
  } {
    __setMaxSpacerPxForTests(CAP)
    return setup({ totalRows: HUGE, getLine: (n: number) => `line ${n}`, ...over })
  }

  it('never sizes the spacer past the engine ceiling', () => {
    const { scroller } = huge()
    fireEvent.scroll(scroller)
    const spacer = scroller.firstElementChild as HTMLElement
    expect(parseFloat(spacer.style.height)).toBeLessThanOrEqual(CAP)
  })

  it('reaches the final row at maximum scroll', () => {
    const { scroller, container } = huge()
    scroller.scrollTop = CAP - 400 // maxScrollTop = spacer - clientHeight
    fireEvent.scroll(scroller)
    expect(container.querySelector(`#line-${HUGE}`)).toBeInTheDocument()
  })

  it('reports the true final row to onVisibleRows at maximum scroll', () => {
    const onVisibleRows = vi.fn()
    const { scroller } = huge({ onVisibleRows })
    scroller.scrollTop = CAP - 400
    fireEvent.scroll(scroller)
    const [, last] = onVisibleRows.mock.calls.at(-1)!
    expect(last).toBe(HUGE - 1)
  })

  it('scrolls to a scrollTarget row past the clamp', () => {
    const { scroller, container, rerender, props } = huge()
    rerender(<VirtualLines {...props} scrollTarget={{ row: 1_500_000, nonce: 1 }} />)
    expect(scroller.scrollTop).toBeLessThanOrEqual(CAP)
    expect(container.querySelector('#line-1500001')).toBeInTheDocument()
  })

  // Padding above the spacer pushes every absolutely-positioned row down by
  // that amount while adding scrollable height the row arithmetic does not
  // model — which left the final line clipped in half at maximum scroll.
  it('leaves no vertical padding above the spacer', () => {
    const { scroller } = huge()
    expect(scroller.style.paddingTop).toBe('0px')
    expect(scroller.style.paddingBottom).toBe('0px')
  })

  it('fits the final row fully inside the viewport at maximum scroll', () => {
    const { scroller, container } = huge()
    scroller.scrollTop = CAP - 400
    fireEvent.scroll(scroller)
    const last = container.querySelector(`#line-${HUGE}`) as HTMLElement
    expect(last).toBeInTheDocument()
    // spacer coords == scroll coords (no vertical padding), so the row's
    // bottom edge must land at or above the viewport's bottom edge
    expect(parseFloat(last.style.top) + ROW_H).toBeLessThanOrEqual(scroller.scrollTop + 400)
  })

  it('keeps the top of the file addressable', () => {
    const { scroller, container } = huge()
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    expect(container.querySelector('#line-1')).toBeInTheDocument()
  })
})
