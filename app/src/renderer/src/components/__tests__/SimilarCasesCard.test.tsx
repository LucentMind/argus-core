// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { SimilarCasesCard } from '../SimilarCasesCard'
import { uiStore } from '../../lib/uiStore'

const HITS = [
  { caseSlug: 'old', signature: 'ECU reset drifts DLT', resolution: 'solved', snippet: '«ECU»' }
]

beforeEach(() => {
  localStorage.clear()
  uiStore.setDynamicTheme(false)
  ;(window as unknown as { argus: unknown }).argus = {
    distill: { similar: vi.fn().mockResolvedValue(HITS) }
  }
})

describe('SimilarCasesCard', () => {
  it('shows hits and opens the past case on click', async () => {
    const open = vi.fn()
    render(<SimilarCasesCard slug="new" onOpenCase={open} />)
    fireEvent.click(await screen.findByRole('button', { name: /ECU reset drifts DLT/ }))
    expect(open).toHaveBeenCalledWith('old')
  })

  it('dismiss persists and hides', async () => {
    render(<SimilarCasesCard slug="new" />)
    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }))
    expect(screen.queryByText(/Similar past cases/)).not.toBeInTheDocument()
    expect(localStorage.getItem('argus:similar-dismissed:new')).toBeTruthy()
  })

  it('renders nothing with zero hits', async () => {
    ;(
      window as never as { argus: { distill: { similar: ReturnType<typeof vi.fn> } } }
    ).argus.distill.similar.mockResolvedValue([])
    render(<SimilarCasesCard slug="new" />)
    await waitFor(() => expect(screen.queryByText(/Similar past cases/)).not.toBeInTheDocument())
  })
})

describe('SimilarCasesCard material', () => {
  it('carries the panel material when the dynamic theme is on', async () => {
    uiStore.setDynamicTheme(true)
    const { container } = render(<SimilarCasesCard slug="new" />)
    await waitFor(() => expect(container.querySelector('.glass-panel')).not.toBeNull())
  })

  it('carries no material when the dynamic theme is off', async () => {
    uiStore.setDynamicTheme(false)
    const { container } = render(<SimilarCasesCard slug="new" />)
    await screen.findByText(/Similar past cases/)
    expect(container.querySelector('.glass-panel')).toBeNull()
  })
})
