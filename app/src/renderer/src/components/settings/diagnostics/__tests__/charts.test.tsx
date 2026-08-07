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

  it('does not crash on a zero-width container', () => {
    render(<TimelineChart {...base} series={[1, 2, 3]} />)
    const svg = screen.getByTestId('diag-timeline-cpu')
    fireEvent.mouseMove(svg, { clientX: 10 })
    expect(screen.queryByTestId('diag-timeline-cpu-tip')).toBeNull()
  })
})
