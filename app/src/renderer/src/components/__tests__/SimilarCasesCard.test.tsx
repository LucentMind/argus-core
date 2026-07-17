// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { SimilarCasesCard } from '../SimilarCasesCard'

const HITS = [
  { caseSlug: 'old', signature: 'ECU reset drifts DLT', resolution: 'solved', snippet: '«ECU»' }
]

beforeEach(() => {
  localStorage.clear()
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
