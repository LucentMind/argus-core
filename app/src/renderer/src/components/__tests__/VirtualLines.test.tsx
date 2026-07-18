// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { VirtualLines, ROW_H } from '../VirtualLines'

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
})
