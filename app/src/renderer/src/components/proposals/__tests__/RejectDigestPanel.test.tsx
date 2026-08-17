// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { RejectDigestPanel } from '../RejectDigestPanel'
import type { RejectDigest } from '../../../../../shared/distill'

function mockArgus(digest: RejectDigest | null): void {
  ;(window as unknown as { argus: unknown }).argus = {
    proposals: {
      rejectDigest: vi.fn().mockResolvedValue(digest)
    }
  }
}

describe('RejectDigestPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders nothing while loading and stays hidden when no digest exists', async () => {
    mockArgus(null)
    const { container } = render(<RejectDigestPanel />)
    expect(container).toBeEmptyDOMElement()
    await waitFor(() => expect(window.argus.proposals.rejectDigest).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the digest collapsed by default, with build metadata and bullets', async () => {
    mockArgus({
      builtAt: '2026-08-15T10:00:00.000Z',
      rejectCount: 12,
      text: '- avoid overgeneric skills\n- never propose recipes for one-off cases'
    })
    render(<RejectDigestPanel />)
    await screen.findByText('Observed failure patterns')
    expect(screen.getByText(/Built 2026-08-15 from 12 rejected proposals/)).toBeInTheDocument()
    // Collapsed: the toggle reports aria-expanded=false and the bullet text is not rendered.
    const toggle = screen.getByRole('button', {
      name: 'Toggle section · Observed failure patterns'
    })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('avoid overgeneric skills')).not.toBeInTheDocument()
  })

  it('expands to reveal the bullet lines', async () => {
    mockArgus({
      builtAt: '2026-08-15T10:00:00.000Z',
      rejectCount: 12,
      text: '- avoid overgeneric skills\n- never propose recipes for one-off cases'
    })
    render(<RejectDigestPanel />)
    await screen.findByText('Observed failure patterns')
    fireEvent.click(
      screen.getByRole('button', { name: 'Toggle section · Observed failure patterns' })
    )
    expect(screen.getByText('avoid overgeneric skills')).toBeInTheDocument()
    expect(screen.getByText('never propose recipes for one-off cases')).toBeInTheDocument()
  })
})
