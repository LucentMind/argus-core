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
    const labels = (
      ['passing', 'failing', 'unstable', 'running', 'none', 'unavailable'] as const
    ).map((r) => {
      const { unmount } = render(<PrRollupDot rollup={r} />)
      const label = screen.getByRole('img').getAttribute('aria-label')!
      unmount()
      return label
    })
    expect(new Set(labels).size).toBe(6)
  })

  it('separates the two amber states by more than motion', () => {
    // Both are amber, and the app has no prefers-reduced-motion rule anywhere, so a pulse must
    // not be the only thing distinguishing "still going" from "something already failed".
    const { unmount } = render(<PrRollupDot rollup="unstable" />)
    const unstable = screen.getByRole('img').className
    unmount()
    render(<PrRollupDot rollup="running" />)
    const running = screen.getByRole('img').className
    expect(unstable).toContain('bg-defect')
    expect(running).toContain('border-defect')
    expect(running).not.toContain('bg-defect')
  })
})
