// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { JiraPill } from '../JiraPill'
import type { JiraRefreshSummary } from '../../../../shared/jira'

const SYNCED_AT = '2026-07-31T14:01:00.000Z'

function summary(overrides?: Partial<JiraRefreshSummary>): JiraRefreshSummary {
  return {
    key: 'NAVPOR-10068',
    statusChange: null,
    newAttachments: [],
    deselectedAttachments: [],
    ingestedAttachments: [],
    deletedOnJira: [],
    newComments: 0,
    syncedAt: SYNCED_AT,
    ...overrides
  }
}

beforeEach(() => {
  window.argus = {
    jira: {
      refreshCase: vi.fn(async () => ({ ok: true as const, value: summary() })),
      openIssue: vi.fn()
    }
  } as never
})

describe('JiraPill', () => {
  it('renders nothing for a case with no Jira key', () => {
    const { container } = render(<JiraPill slug="nn-5187" jiraKey={null} syncedAt={SYNCED_AT} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the issue key and a resting timestamp', () => {
    render(<JiraPill slug="nn-5187" jiraKey="NAVPOR-10068" syncedAt={SYNCED_AT} />)
    expect(screen.getByText('NAVPOR-10068')).toBeTruthy()
    expect(screen.getByTestId('jira-pill-state').textContent).not.toBe('')
  })

  it('reports counts on the face after a refresh that found changes', async () => {
    const user = userEvent.setup()
    window.argus.jira.refreshCase = vi.fn(async () => ({
      ok: true as const,
      value: summary({ statusChange: { from: 'Open', to: 'In Progress' }, newComments: 2 })
    }))
    render(<JiraPill slug="nn-5187" jiraKey="NAVPOR-10068" syncedAt={SYNCED_AT} />)
    await user.click(screen.getByRole('button', { name: 'Refresh from Jira' }))
    expect((await screen.findByTestId('jira-pill-state')).textContent).toBe('↑ · 2c')
  })

  it('keeps a failure on the face instead of falling back to the last good stamp', async () => {
    const user = userEvent.setup()
    window.argus.jira.refreshCase = vi.fn(async () => ({
      ok: false as const,
      code: 'auth' as const,
      message: 'Jira returned 403'
    }))
    render(<JiraPill slug="nn-5187" jiraKey="NAVPOR-10068" syncedAt={SYNCED_AT} />)
    await user.click(screen.getByRole('button', { name: 'Refresh from Jira' }))
    expect((await screen.findByTestId('jira-pill-state')).textContent).toBe('failed')
  })

  it('puts the full message and Open in Jira in the popover, not on the face', async () => {
    const user = userEvent.setup()
    window.argus.jira.refreshCase = vi.fn(async () => ({
      ok: false as const,
      code: 'auth' as const,
      message: 'Jira returned 403'
    }))
    render(<JiraPill slug="nn-5187" jiraKey="NAVPOR-10068" syncedAt={SYNCED_AT} />)
    await user.click(screen.getByRole('button', { name: 'Refresh from Jira' }))
    await screen.findByTestId('jira-pill-state')
    await user.click(screen.getByRole('button', { name: 'Jira details' }))
    expect(screen.getByText('Jira returned 403')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Open in Jira' }))
    expect(window.argus.jira.openIssue).toHaveBeenCalledWith('nn-5187')
  })

  it('opens the attachments dialog when a refresh brings new attachments', async () => {
    const user = userEvent.setup()
    window.argus.jira.refreshCase = vi.fn(async () => ({
      ok: true as const,
      value: summary({
        newAttachments: [
          { attachmentId: '1', filename: 'trace.log', mimeType: 'text/plain', size: 10 }
        ] as unknown as JiraRefreshSummary['newAttachments']
      })
    }))
    render(<JiraPill slug="nn-5187" jiraKey="NAVPOR-10068" syncedAt={SYNCED_AT} />)
    await user.click(screen.getByRole('button', { name: 'Refresh from Jira' }))
    expect(await screen.findByText('trace.log')).toBeTruthy()
  })
})
