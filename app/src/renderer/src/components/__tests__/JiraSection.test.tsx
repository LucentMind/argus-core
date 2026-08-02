// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { JiraSection } from '../JiraSection'
import { chipStamp } from '../../lib/time'
import { COUNTS_DECAY_MS, ACK_DECAY_MS } from '../../lib/jiraSyncState'
import type { JiraRefreshSummary } from '../../../../shared/jira'

const SYNCED_AT = '2026-07-31T14:01:00.000Z'
// The case title, which for a ticket-derived case is the Jira summary — see JiraSection.
const TITLE = 'Navigation drops the route on tunnel exit'

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

describe('JiraSection', () => {
  it('renders nothing for a case with no Jira key', () => {
    const { container } = render(
      <JiraSection slug="nn-5187" jiraKey={null} title={TITLE} syncedAt={SYNCED_AT} />
    )
    expect(container.firstChild).toBeNull()
  })

  // Always open (user-directed, 2026-08-02): the ticket, when it was last pulled, and the one
  // action are all on screen — nothing is behind a disclosure any more.
  it('shows the ticket title and the last-refreshed line without any interaction', () => {
    render(<JiraSection slug="nn-5187" jiraKey="NAVPOR-10068" title={TITLE} syncedAt={SYNCED_AT} />)
    expect(screen.getByText(TITLE)).toBeTruthy()
    expect(screen.getByTestId('jira-sync-line').textContent).toBe(
      `Last refreshed ${chipStamp(SYNCED_AT)}`
    )
    // the popover and its trigger are gone, not moved
    expect(screen.queryByRole('button', { name: 'Jira details' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open in Jira' })).toBeNull()
  })

  // Neither an id nor a heading is printed in this panel (user-directed, 2026-08-02): both only
  // restated what the ticket's own title already says. The id survives as the accessible name,
  // so the control still announces which ticket it opens.
  it('prints no id and no heading, but still names the ticket for a screen reader', () => {
    const { container } = render(
      <JiraSection slug="nn-5187" jiraKey="NAVPOR-10068" title={TITLE} syncedAt={SYNCED_AT} />
    )
    expect(screen.queryByText('NAVPOR-10068')).toBeNull()
    expect(screen.queryByText(/^(issue|jira ticket)$/i)).toBeNull()
    // the panel is exactly the box and its refresh button — nothing above them
    expect(container.firstElementChild?.childElementCount).toBe(1)
    expect(screen.getByRole('button', { name: 'Open NAVPOR-10068 in Jira' })).toBeTruthy()
  })

  it('opens the ticket from the box, not just its text', async () => {
    const user = userEvent.setup()
    render(<JiraSection slug="nn-5187" jiraKey="NAVPOR-10068" title={TITLE} syncedAt={SYNCED_AT} />)
    await user.click(screen.getByRole('button', { name: 'Open NAVPOR-10068 in Jira' }))
    expect(window.argus.jira.openIssue).toHaveBeenCalledWith('nn-5187')
  })

  it('says what a refresh found, in prose, on the second line', async () => {
    const user = userEvent.setup()
    window.argus.jira.refreshCase = vi.fn(async () => ({
      ok: true as const,
      value: summary({ statusChange: { from: 'Open', to: 'In Progress' }, newComments: 2 })
    }))
    render(<JiraSection slug="nn-5187" jiraKey="NAVPOR-10068" title={TITLE} syncedAt={SYNCED_AT} />)
    await user.click(screen.getByRole('button', { name: 'Refresh from Jira' }))
    expect((await screen.findByTestId('jira-sync-line')).textContent).toBe(
      'status Open → In Progress · 2 new comments'
    )
  })

  it('keeps the whole failure message on the line instead of the last good stamp', async () => {
    const user = userEvent.setup()
    window.argus.jira.refreshCase = vi.fn(async () => ({
      ok: false as const,
      code: 'auth' as const,
      message: 'Jira returned 403'
    }))
    render(<JiraSection slug="nn-5187" jiraKey="NAVPOR-10068" title={TITLE} syncedAt={SYNCED_AT} />)
    await user.click(screen.getByRole('button', { name: 'Refresh from Jira' }))
    const line = await screen.findByRole('alert')
    expect(line.textContent).toBe('Jira returned 403')
    // the rail is fixed-width, so the untruncated text has to survive somewhere
    expect(line).toHaveAttribute('title', 'Jira returned 403')
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
    render(<JiraSection slug="nn-5187" jiraKey="NAVPOR-10068" title={TITLE} syncedAt={SYNCED_AT} />)
    await user.click(screen.getByRole('button', { name: 'Refresh from Jira' }))
    expect(await screen.findByText('trace.log')).toBeTruthy()
  })
})

/**
 * The result line is an announcement, not a reading. The resting stamp is the thing that
 * answers "should I re-sync", so a result that never yields it back leaves the section
 * permanently unable to answer its own question.
 */
describe('JiraSection result decay', () => {
  // Fake timers and RTL's async helpers (`findBy*`, `waitFor`) do not compose here — the
  // helpers poll on a faked interval that nothing advances, so they hang to the test timeout.
  // Every other fake-timer suite in this repo does the same: fireEvent + explicit act.
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const click = async (name: string): Promise<void> => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name }))
    })
  }

  const tick = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  const lineText = (): string | null => screen.getByTestId('jira-sync-line').textContent
  const resting = `Last refreshed ${chipStamp(SYNCED_AT)}`

  it('decays a result back to the resting stamp', async () => {
    window.argus.jira.refreshCase = vi.fn(async () => ({
      ok: true as const,
      value: summary({ statusChange: { from: 'Open', to: 'In Progress' }, newComments: 2 })
    }))
    render(<JiraSection slug="nn-5187" jiraKey="NAVPOR-10068" title={TITLE} syncedAt={SYNCED_AT} />)
    await click('Refresh from Jira')
    expect(lineText()).toBe('status Open → In Progress · 2 new comments')

    tick(COUNTS_DECAY_MS - 1)
    expect(lineText()).toBe('status Open → In Progress · 2 new comments')

    tick(1)
    expect(lineText()).toBe(resting)
  })

  it('decays the no-changes acknowledgement', async () => {
    render(<JiraSection slug="nn-5187" jiraKey="NAVPOR-10068" title={TITLE} syncedAt={SYNCED_AT} />)
    await click('Refresh from Jira')
    expect(lineText()).toBe('Up to date')

    tick(ACK_DECAY_MS - 1)
    expect(lineText()).toBe('Up to date')

    tick(1)
    expect(lineText()).toBe(resting)
  })

  it('keeps a failure on the line indefinitely', async () => {
    window.argus.jira.refreshCase = vi.fn(async () => ({
      ok: false as const,
      code: 'auth' as const,
      message: 'Jira returned 403'
    }))
    render(<JiraSection slug="nn-5187" jiraKey="NAVPOR-10068" title={TITLE} syncedAt={SYNCED_AT} />)
    await click('Refresh from Jira')
    expect(lineText()).toBe('Jira returned 403')

    tick(COUNTS_DECAY_MS * 10)
    expect(lineText()).toBe('Jira returned 403')
  })

  it('does not burn the acknowledgement behind the attachments dialog', async () => {
    window.argus.jira.refreshCase = vi.fn(async () => ({
      ok: true as const,
      value: summary({
        newAttachments: [
          { attachmentId: '1', filename: 'trace.log', mimeType: 'text/plain', size: 10 }
        ] as unknown as JiraRefreshSummary['newAttachments']
      })
    }))
    render(<JiraSection slug="nn-5187" jiraKey="NAVPOR-10068" title={TITLE} syncedAt={SYNCED_AT} />)
    await click('Refresh from Jira')
    expect(screen.getByText('trace.log')).toBeTruthy()

    // The dialog covers the rail — the decay window must not run out unseen behind it.
    tick(COUNTS_DECAY_MS * 3)
    expect(lineText()).toBe('1 new attachment')

    await click('Cancel')
    expect(lineText()).toBe('1 new attachment')
    tick(COUNTS_DECAY_MS)
    expect(lineText()).toBe(resting)
  })

  it('clears a pending decay timer on unmount', async () => {
    const { unmount } = render(
      <JiraSection slug="nn-5187" jiraKey="NAVPOR-10068" title={TITLE} syncedAt={SYNCED_AT} />
    )
    await click('Refresh from Jira')
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
