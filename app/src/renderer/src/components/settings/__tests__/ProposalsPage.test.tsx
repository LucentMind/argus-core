// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ProposalsPage } from '../ProposalsPage'
import type { ProposalsPayload } from '../../../../../shared/proposals'

const payload: ProposalsPayload = {
  proposals: [
    {
      file: '2026-07-10-NAV-100-rca.md',
      type: 'skill-edit',
      target: 'rca',
      caseSlug: 'NAV-100',
      date: '2026-07-10T12:00:00.000Z',
      title: 'Sharpen step 4',
      content: '# rca\nnew line\n',
      current: '# rca\nold line\n'
    }
  ]
}

beforeEach(() => {
  ;(window as unknown as { argus: unknown }).argus = {
    proposals: {
      list: vi.fn().mockResolvedValue(payload),
      accept: vi.fn().mockResolvedValue({ proposals: [] }),
      reject: vi.fn().mockResolvedValue({ proposals: [] })
    }
  }
})

describe('ProposalsPage', () => {
  it('renders pending proposals with a line diff', async () => {
    render(<ProposalsPage />)
    expect(await screen.findByText('Sharpen step 4')).toBeInTheDocument()
    expect(screen.getByText('- old line')).toBeInTheDocument()
    expect(screen.getByText('+ new line')).toBeInTheDocument()
  })

  it('accept invokes the IPC, refreshes and clears the proposal', async () => {
    render(<ProposalsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Accept Sharpen step 4' }))
    expect(
      (window as unknown as { argus: { proposals: { accept: ReturnType<typeof vi.fn> } } }).argus
        .proposals.accept
    ).toHaveBeenCalledWith('2026-07-10-NAV-100-rca.md')
    expect(await screen.findByText(/No pending proposals/)).toBeInTheDocument()
  })

  it('reject archives without applying', async () => {
    render(<ProposalsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reject Sharpen step 4' }))
    await waitFor(() =>
      expect(
        (window as unknown as { argus: { proposals: { reject: ReturnType<typeof vi.fn> } } }).argus
          .proposals.reject
      ).toHaveBeenCalled()
    )
  })

  it('mount fetch error surfaces in alert banner instead of hanging', async () => {
    ;(window as unknown as { argus: unknown }).argus = {
      proposals: {
        list: vi.fn().mockRejectedValue(new Error('ipc dead')),
        accept: vi.fn().mockResolvedValue({ proposals: [] }),
        reject: vi.fn().mockResolvedValue({ proposals: [] })
      }
    }
    render(<ProposalsPage />)
    // Assert loading text is gone and error banner appears
    await waitFor(() => {
      expect(screen.queryByText('loading…')).not.toBeInTheDocument()
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(/ipc dead/)
  })
})
