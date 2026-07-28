// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PrRollupDot } from '../PrRollupDot'

describe('PrRollupDot', () => {
  it('names the state for screen readers rather than relying on colour alone', () => {
    render(<PrRollupDot rollup="failing" />)
    expect(screen.getByRole('img', { name: /checks failing/i })).toBeInTheDocument()
  })

  it('has a distinct label per rollup', () => {
    const labels = (['passing', 'failing', 'running', 'none', 'unavailable'] as const).map((r) => {
      const { unmount } = render(<PrRollupDot rollup={r} />)
      const label = screen.getByRole('img').getAttribute('aria-label')!
      unmount()
      return label
    })
    expect(new Set(labels).size).toBe(5)
  })
})
