// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { JiraRefreshButton } from '../JiraRefreshButton'

let refreshCase: ReturnType<typeof vi.fn>

beforeEach(() => {
  refreshCase = vi.fn()
  window.argus = { jira: { refreshCase } } as never
})

describe('JiraRefreshButton', () => {
  it('renders nothing without a jira link', () => {
    const { container } = render(<JiraRefreshButton slug="X-1" jiraKey={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('refreshes and shows the change summary', async () => {
    refreshCase.mockResolvedValue({
      ok: true,
      value: {
        key: 'NAV-7',
        statusChange: { from: 'Open', to: 'Resolved' },
        newAttachments: [
          { id: '1', filename: 'a', size: 1, mimeType: '', createdAt: '' },
          { id: '2', filename: 'b', size: 1, mimeType: '', createdAt: '' }
        ],
        deletedOnJira: [{ attachmentId: '3', filename: 'gone.txt' }]
      }
    })
    render(<JiraRefreshButton slug="NAV-7" jiraKey="NAV-7" />)
    fireEvent.click(screen.getByRole('button', { name: /refresh from jira/i }))
    const note = await screen.findByText(/2 new attachments/i)
    expect(note).toHaveTextContent('status Open → Resolved')
    expect(note).toHaveTextContent('1 attachment deleted on Jira (kept locally)')
    expect(refreshCase).toHaveBeenCalledWith('NAV-7')
  })

  it('reports "no changes" and surfaces typed errors', async () => {
    refreshCase.mockResolvedValueOnce({
      ok: true,
      value: { key: 'NAV-7', statusChange: null, newAttachments: [], deletedOnJira: [] }
    })
    render(<JiraRefreshButton slug="NAV-7" jiraKey="NAV-7" />)
    fireEvent.click(screen.getByRole('button', { name: /refresh from jira/i }))
    expect(await screen.findByText(/no changes/i)).toBeInTheDocument()

    refreshCase.mockResolvedValueOnce({
      ok: false,
      code: 'auth',
      message: 'Atlassian rejected the API token'
    })
    fireEvent.click(screen.getByRole('button', { name: /refresh from jira/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/rejected the API token/i)
  })
})
