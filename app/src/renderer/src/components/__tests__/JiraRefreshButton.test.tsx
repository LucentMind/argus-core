// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { JiraRefreshButton } from '../JiraRefreshButton'
import { shortStamp } from '../../lib/time'

let refreshCase: ReturnType<typeof vi.fn>

beforeEach(() => {
  refreshCase = vi.fn()
  window.argus = {
    jira: {
      refreshCase,
      ingestAttachments: vi.fn(async () => ({ ok: true, value: [] })),
      setAttachmentSelection: vi.fn(async () => ({ ok: true, value: {} }))
    }
  } as never
})

describe('JiraRefreshButton', () => {
  it('renders nothing without a jira link', () => {
    const { container } = render(<JiraRefreshButton slug="X-1" jiraKey={null} syncedAt={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the last-refreshed datetime from the stored value', () => {
    render(<JiraRefreshButton slug="NAV-7" jiraKey="NAV-7" syncedAt="2026-07-10T10:00:00.000Z" />)
    const stamp = screen.getByText(/last refreshed/i)
    expect(stamp).toHaveTextContent(shortStamp('2026-07-10T10:00:00.000Z'))
  })

  it('shows no datetime before the first refresh', () => {
    render(<JiraRefreshButton slug="NAV-7" jiraKey="NAV-7" syncedAt={null} />)
    expect(screen.queryByText(/last refreshed/i)).toBeNull()
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
  })

  it('refreshes, shows the change summary, and advances the datetime', async () => {
    refreshCase.mockResolvedValue({
      ok: true,
      value: {
        key: 'NAV-7',
        statusChange: { from: 'Open', to: 'Resolved' },
        newAttachments: [
          { id: '1', filename: 'a', size: 1, mimeType: '', createdAt: '' },
          { id: '2', filename: 'b', size: 1, mimeType: '', createdAt: '' }
        ],
        deselectedAttachments: [],
        deletedOnJira: [{ attachmentId: '3', filename: 'gone.txt' }],
        newComments: 2,
        syncedAt: '2026-07-11T12:30:00.000Z'
      }
    })
    render(<JiraRefreshButton slug="NAV-7" jiraKey="NAV-7" syncedAt="2026-07-10T10:00:00.000Z" />)
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    const note = await screen.findByText(/2 new attachments/i)
    expect(note).toHaveTextContent('status Open → Resolved')
    expect(note).toHaveTextContent('1 attachment deleted on Jira (kept locally)')
    expect(note).toHaveTextContent('2 new comments')
    expect(refreshCase).toHaveBeenCalledWith('NAV-7')
    expect(screen.getByText(/last refreshed/i)).toHaveTextContent(
      shortStamp('2026-07-11T12:30:00.000Z')
    )
  })

  it('renders a real button with a refresh icon', () => {
    render(<JiraRefreshButton slug="NAV-7" jiraKey="NAV-7" syncedAt={null} />)
    const btn = screen.getByRole('button', { name: /refresh/i })
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.querySelector('svg')).not.toBeNull()
  })

  it('reports "no changes" and surfaces typed errors', async () => {
    refreshCase.mockResolvedValueOnce({
      ok: true,
      value: {
        key: 'NAV-7',
        statusChange: null,
        newAttachments: [],
        deselectedAttachments: [],
        deletedOnJira: [],
        newComments: 0,
        syncedAt: '2026-07-11T12:30:00.000Z'
      }
    })
    render(<JiraRefreshButton slug="NAV-7" jiraKey="NAV-7" syncedAt={null} />)
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    expect(await screen.findByText(/no changes/i)).toBeInTheDocument()

    refreshCase.mockResolvedValueOnce({
      ok: false,
      code: 'auth',
      message: 'Atlassian rejected the API token'
    })
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/rejected the API token/i)
  })

  it('opens the attachments dialog when refresh finds new attachments', async () => {
    refreshCase.mockResolvedValue({
      ok: true,
      value: {
        key: 'NAV-7',
        statusChange: null,
        newAttachments: [{ id: '1', filename: 'a.txt', size: 1, mimeType: '', createdAt: '' }],
        deselectedAttachments: [],
        deletedOnJira: [],
        newComments: 0,
        syncedAt: '2026-07-11T12:30:00.000Z'
      }
    })
    render(<JiraRefreshButton slug="NAV-7" jiraKey="NAV-7" syncedAt={null} />)
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    expect(await screen.findByRole('dialog', { name: /attachments changed/i })).toBeInTheDocument()
  })

  it('does not open the attachments dialog when there are no new attachments', async () => {
    refreshCase.mockResolvedValue({
      ok: true,
      value: {
        key: 'NAV-7',
        statusChange: null,
        newAttachments: [],
        deselectedAttachments: [],
        deletedOnJira: [],
        newComments: 0,
        syncedAt: '2026-07-11T12:30:00.000Z'
      }
    })
    render(<JiraRefreshButton slug="NAV-7" jiraKey="NAV-7" syncedAt={null} />)
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await screen.findByText(/no changes/i)
    expect(screen.queryByRole('dialog', { name: /attachments changed/i })).toBeNull()
  })
})
