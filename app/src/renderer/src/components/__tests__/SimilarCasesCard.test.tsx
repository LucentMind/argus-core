// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { SimilarCasesCard } from '../SimilarCasesCard'
import { uiStore } from '../../lib/uiStore'

const HITS = [
  { caseSlug: 'old', signature: 'ECU reset drifts DLT', resolution: 'solved', snippet: '«ECU»' }
]

const DEFECT_RESULTS = [
  {
    sourceId: 'src1',
    sourceName: 'Hindsight',
    ok: true,
    hits: [
      {
        key: 'BUG-123',
        url: 'https://corpus.example/browse/BUG-123',
        score: 0.9,
        matchedOn: 'lexical',
        snippet: '«ECU»',
        record: {
          key: 'BUG-123',
          url: 'https://corpus.example/browse/BUG-123',
          summary: 'ECU reset drifts DLT clock'
        }
      }
    ]
  }
]

function setArgus(overrides: { similar?: unknown[] | Error; defects?: unknown[] | Error }): void {
  const similarImpl =
    overrides.similar instanceof Error
      ? vi.fn().mockRejectedValue(overrides.similar)
      : vi.fn().mockResolvedValue(overrides.similar ?? HITS)
  const defectsImpl =
    overrides.defects instanceof Error
      ? vi.fn().mockRejectedValue(overrides.defects)
      : vi.fn().mockResolvedValue(overrides.defects ?? [])
  ;(window as unknown as { argus: unknown }).argus = {
    distill: { similar: similarImpl },
    defects: { search: defectsImpl }
  }
}

beforeEach(() => {
  localStorage.clear()
  uiStore.setDynamicTheme(false)
  setArgus({})
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

describe('SimilarCasesCard known defects', () => {
  it('renders corpus hits with source label and href', async () => {
    setArgus({ similar: [], defects: DEFECT_RESULTS })
    render(<SimilarCasesCard slug="new" title="ECU reset" jiraKey="PROJ-1" />)
    const link = await screen.findByRole('link', {
      name: /BUG-123.*ECU reset drifts DLT clock.*Hindsight/
    })
    expect(link).toHaveAttribute('href', 'https://corpus.example/browse/BUG-123')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('dismissing the known-defects section leaves local hits visible', async () => {
    setArgus({ similar: HITS, defects: DEFECT_RESULTS })
    render(<SimilarCasesCard slug="new" title="ECU reset" jiraKey="PROJ-1" />)
    await screen.findByText(/BUG-123/)
    fireEvent.click(screen.getByRole('button', { name: /dismiss known defects/i }))
    expect(screen.queryByText(/BUG-123/)).not.toBeInTheDocument()
    expect(screen.getByText(/Similar past cases/)).toBeInTheDocument()
    expect(localStorage.getItem('argus:known-defects-dismissed:new')).toBeTruthy()
    expect(localStorage.getItem('argus:similar-dismissed:new')).toBeFalsy()
  })

  it('renders nothing when both sections are empty', async () => {
    setArgus({ similar: [], defects: [] })
    render(<SimilarCasesCard slug="new" title="ECU reset" jiraKey="PROJ-1" />)
    await waitFor(() => expect(screen.queryByText(/Similar past cases/)).not.toBeInTheDocument())
    expect(screen.queryByText(/Known defects/)).not.toBeInTheDocument()
  })

  it('swallows a defects.search rejection and still renders local hits', async () => {
    setArgus({ similar: HITS, defects: new Error('corpus unreachable') })
    render(<SimilarCasesCard slug="new" title="ECU reset" jiraKey="PROJ-1" />)
    await screen.findByText(/Similar past cases/)
    expect(screen.queryByText(/Known defects/)).not.toBeInTheDocument()
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
