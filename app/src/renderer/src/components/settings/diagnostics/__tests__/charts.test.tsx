// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Sparkline } from '../Sparkline'
import { TimelineChart } from '../TimelineChart'

describe('Sparkline', () => {
  it('draws a path for a populated series', () => {
    render(<Sparkline series={[1, 2, 3]} max={10} bridge={3} label="CPU for foo" />)
    const svg = screen.getByTestId('diag-sparkline')
    expect(svg).toHaveAttribute('data-empty', 'false')
    expect(svg.querySelector('path')?.getAttribute('d')).toContain('M')
  })

  it('renders an empty marker rather than a broken path when there is no data', () => {
    render(<Sparkline series={[null, null]} max={10} bridge={3} label="CPU for foo" />)
    const svg = screen.getByTestId('diag-sparkline')
    expect(svg).toHaveAttribute('data-empty', 'true')
    expect(svg.querySelector('path')).toBeNull()
  })

  it('renders a process whose whole life fits in one bucket as a dot, not nothing', () => {
    // Two correct-in-isolation decisions (a 1-point run has no line; an ended row's
    // numeric cells are all em-dashes) used to combine into a hole: a crash-looping
    // process — the flagship scenario this ring exists to surface — rendered as a label
    // and four dashes with an empty <svg> in between. A zero-length `M x yL x y` segment
    // with a round linecap closes that gap.
    render(<Sparkline series={[7, null, null]} max={10} bridge={3} label="CPU for foo" />)
    const svg = screen.getByTestId('diag-sparkline')
    expect(svg).toHaveAttribute('data-empty', 'false')
    const d = svg.querySelector('path')?.getAttribute('d')
    expect(d).toMatch(/^M(-?[\d.]+) (-?[\d.]+)L\1 \2$/)
    expect(svg.querySelector('path')).toHaveAttribute('stroke-linecap', 'round')
  })
})

describe('TimelineChart', () => {
  const base = {
    testId: 'diag-timeline-cpu',
    title: 'CPU · peak per 5s',
    kind: 'percent' as const,
    accent: '--signal',
    bridge: 3,
    from: 1_700_000_000_000,
    bucketMs: 5_000,
    format: (v: number) => `${v.toFixed(1)}%`
  }

  it('publishes its bucket count so a live gate can see the window change', () => {
    render(<TimelineChart {...base} series={[1, 2, 3, 4]} />)
    expect(screen.getByTestId('diag-timeline-cpu')).toHaveAttribute('data-buckets', '4')
  })

  it('shows a crosshair and a tooltip on hover', () => {
    render(<TimelineChart {...base} series={[1, 2, 3, 4, 5]} />)
    const svg = screen.getByTestId('diag-timeline-cpu')
    // jsdom reports a zero-size rect, so the component's own guard would bail out.
    // Stub the geometry to prove the index mapping, not jsdom's layout engine.
    svg.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 120 }) as DOMRect

    fireEvent.mouseMove(svg, { clientX: 100 })
    expect(screen.getByTestId('diag-timeline-cpu-tip')).toHaveTextContent('5.0%')

    fireEvent.mouseLeave(svg)
    expect(screen.queryByTestId('diag-timeline-cpu-tip')).toBeNull()
  })

  it('says so plainly when the hovered bucket holds no sample', () => {
    render(<TimelineChart {...base} series={[1, null, 3]} />)
    const svg = screen.getByTestId('diag-timeline-cpu')
    svg.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 120 }) as DOMRect

    fireEvent.mouseMove(svg, { clientX: 50 })
    expect(screen.getByTestId('diag-timeline-cpu-tip')).toHaveTextContent('no sample')
  })

  it('never shows NaN when the series shrinks out from under a stale hover index', () => {
    // `hover` is component state holding an index; `series` is a prop whose length
    // changes when the timeline window changes (720 buckets at 1h, 60 at 5m). React
    // preserves `hover` across that prop change, so the old index can point past the end
    // of the new, shorter series. Reachable by keyboard (hover near the right edge, then
    // Tab to a window button and press Enter) without ever firing onMouseLeave.
    //
    // `format` mirrors DiagnosticsSettings.tsx's real formatPercent, which is what
    // actually turns an undefined lookup into the literal string "NaN%" — the generic
    // `base.format` above would throw on `undefined.toFixed`, masking the real defect.
    const formatPercent = (v: number): string => `${(Math.round(v * 10) / 10).toFixed(1)}%`
    const long = Array.from({ length: 720 }, (_, i) => i)
    const { rerender } = render(<TimelineChart {...base} series={long} format={formatPercent} />)
    const svg = screen.getByTestId('diag-timeline-cpu')
    svg.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 120 }) as DOMRect

    // Hover right at the far edge, pinning `hover` to the last valid index (719).
    fireEvent.mouseMove(svg, { clientX: 100 })
    expect(screen.getByTestId('diag-timeline-cpu-tip')).toHaveTextContent('719.0%')

    // The window narrows to 60 buckets. The pointer never left the SVG, so onMouseLeave
    // never fires and `hover` survives the re-render pointing at an index the new series
    // doesn't have.
    const short = Array.from({ length: 60 }, (_, i) => i)
    rerender(<TimelineChart {...base} series={short} format={formatPercent} />)

    const tip = screen.queryByTestId('diag-timeline-cpu-tip')
    expect(tip?.textContent ?? '').not.toContain('NaN')
  })

  it('does not crash on a zero-width container', () => {
    render(<TimelineChart {...base} series={[1, 2, 3]} />)
    const svg = screen.getByTestId('diag-timeline-cpu')
    fireEvent.mouseMove(svg, { clientX: 10 })
    expect(screen.queryByTestId('diag-timeline-cpu-tip')).toBeNull()
  })
})
