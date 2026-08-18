// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { JiraAttachmentsDialog, type TicketGroup } from '../JiraAttachmentsDialog'
import { __resetEscapeLayersForTest } from '../../lib/escapeLayer'
import { panelsStore } from '../../lib/panelsStore'
import type { JiraAttachmentInfo } from '../../../../shared/jira'

const att = (id: string, filename: string): JiraAttachmentInfo => ({
  id,
  filename,
  size: 9,
  mimeType: 'text/plain',
  createdAt: '2026-07-02T00:00:00Z'
})

/** The case's own ticket, with today's three bands — the shape every pre-`groups` test used. */
const primary = (over: Partial<TicketGroup> = {}): TicketGroup => ({
  jiraKey: 'NAV-7',
  role: 'primary',
  newAttachments: [],
  deselectedAttachments: [],
  ingestedAttachments: [],
  ...over
})

const source = (over: Partial<TicketGroup> = {}): TicketGroup =>
  primary({ jiraKey: 'CUST-9', role: 'source', ...over })

beforeEach(() => {
  window.argus = {
    jira: {
      ingestAttachments: vi.fn(async () => ({ ok: true, value: [] })),
      setAttachmentSelection: vi.fn(async () => ({ ok: true, value: {} })),
      setSourceAttachmentSelection: vi.fn(async () => ({ ok: true, value: undefined }))
    }
  } as never
})

afterEach(() => __resetEscapeLayersForTest())

describe('JiraAttachmentsDialog', () => {
  // Same occlusion hazard as PrPickerDialog: a docked panel paints above all DOM, so this
  // dialog must register itself with panelsStore to hide the panel while it's open.
  it('registers as a panelsStore occlusion source on mount and deregisters on unmount', () => {
    expect(panelsStore.get().occluded).toBe(false)
    const { unmount } = render(
      <JiraAttachmentsDialog slug="NAV-7" groups={[primary()]} onClose={() => {}} />
    )
    expect(panelsStore.get().occluded).toBe(true)
    unmount()
    expect(panelsStore.get().occluded).toBe(false)
  })

  it('pre-checks new attachments and leaves previously deselected unchecked', () => {
    render(
      <JiraAttachmentsDialog
        slug="NAV-7"
        groups={[
          primary({
            newAttachments: [att('1', 'new.txt')],
            deselectedAttachments: [att('2', 'old.txt')]
          })
        ]}
        onClose={() => {}}
      />
    )
    expect(screen.getByRole('checkbox', { name: /new\.txt/i })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /old\.txt/i })).not.toBeChecked()
  })

  it('shows already-synced attachments checked+disabled and excludes them from confirm', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <JiraAttachmentsDialog
        slug="NAV-7"
        groups={[
          primary({
            newAttachments: [att('1', 'new.txt')],
            ingestedAttachments: [att('9', 'synced.txt')]
          })
        ]}
        onClose={onClose}
      />
    )
    const syncedBox = screen.getByRole('checkbox', { name: /synced\.txt/i })
    expect(syncedBox).toBeChecked()
    expect(syncedBox).toBeDisabled()
    expect(screen.getByText('synced')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /download selected/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    // the synced id appears in NEITHER payload: not re-downloaded, not deselected
    expect(window.argus.jira.ingestAttachments).toHaveBeenCalledWith('NAV-7', 'NAV-7', [
      expect.objectContaining({ id: '1' })
    ])
    expect(window.argus.jira.setAttachmentSelection).toHaveBeenCalledWith('NAV-7', [])
  })

  it('confirm ingests checked and persists unchecked as the new deselection set', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <JiraAttachmentsDialog
        slug="NAV-7"
        groups={[
          primary({
            newAttachments: [att('1', 'new.txt')],
            deselectedAttachments: [att('2', 'old.txt')]
          })
        ]}
        onClose={onClose}
      />
    )
    await user.click(screen.getByRole('button', { name: /download selected/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(window.argus.jira.ingestAttachments).toHaveBeenCalledWith('NAV-7', 'NAV-7', [
      expect.objectContaining({ id: '1' })
    ])
    expect(window.argus.jira.setAttachmentSelection).toHaveBeenCalledWith('NAV-7', ['2'])
  })

  it('toggle-all selects every selectable row, then clears them all', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <JiraAttachmentsDialog
        slug="NAV-7"
        groups={[
          primary({
            newAttachments: [att('1', 'new.txt')],
            deselectedAttachments: [att('2', 'old.txt')],
            ingestedAttachments: [att('9', 'synced.txt')]
          })
        ]}
        onClose={onClose}
      />
    )
    // one of two selected, so the toggle offers the completing action
    await user.click(screen.getByRole('button', { name: /select all/i }))
    expect(screen.getByRole('checkbox', { name: /old\.txt/i })).toBeChecked()

    await user.click(screen.getByRole('button', { name: /deselect all/i }))
    expect(screen.getByRole('checkbox', { name: /new\.txt/i })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /old\.txt/i })).not.toBeChecked()
    // the synced row is not the toggle's to touch, and stays out of both payloads
    expect(screen.getByRole('checkbox', { name: /synced\.txt/i })).toBeChecked()

    await user.click(screen.getByRole('button', { name: /download selected/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(window.argus.jira.ingestAttachments).not.toHaveBeenCalled()
    expect(window.argus.jira.setAttachmentSelection).toHaveBeenCalledWith('NAV-7', ['1', '2'])
  })

  it('toggle-all spans every group, not just the first', async () => {
    const user = userEvent.setup()
    render(
      <JiraAttachmentsDialog
        slug="NAV-7"
        groups={[
          primary({ deselectedAttachments: [att('1', 'own.txt')] }),
          source({ deselectedAttachments: [att('2', 'cust.txt')] })
        ]}
        onClose={vi.fn()}
      />
    )
    await user.click(screen.getByRole('button', { name: /select all/i }))
    expect(screen.getByRole('checkbox', { name: /own\.txt/i })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /cust\.txt/i })).toBeChecked()
  })

  it('hides the toggle when every row is already synced', () => {
    render(
      <JiraAttachmentsDialog
        slug="NAV-7"
        groups={[primary({ ingestedAttachments: [att('9', 'synced.txt')] })]}
        onClose={() => {}}
      />
    )
    expect(screen.queryByRole('button', { name: /select all/i })).toBeNull()
  })

  it('sorts by type within each bucket, leaving the buckets themselves in order', () => {
    const typed = (id: string, filename: string, mimeType: string): JiraAttachmentInfo => ({
      ...att(id, filename),
      mimeType
    })
    render(
      <JiraAttachmentsDialog
        slug="NAV-7"
        groups={[
          primary({
            newAttachments: [
              typed('1', 'b.txt', 'text/plain'),
              typed('2', 'dump.bin', 'application/octet-stream'),
              typed('3', 'a.txt', 'text/plain')
            ],
            deselectedAttachments: [typed('4', 'skipped.txt', 'text/plain')],
            ingestedAttachments: [typed('5', 'synced.txt', 'text/plain')]
          })
        ]}
        onClose={() => {}}
      />
    )
    const names = screen
      .getAllByRole('checkbox')
      .map((b) => b.getAttribute('aria-label') ?? b.getAttribute('name') ?? '')
    // new (by type, then name) → previously skipped → synced
    expect(names).toEqual(['dump.bin', 'a.txt', 'b.txt', 'skipped.txt', 'synced.txt'])
  })

  it('cancel calls neither API', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <JiraAttachmentsDialog
        slug="NAV-7"
        groups={[primary({ newAttachments: [att('1', 'new.txt')] })]}
        onClose={onClose}
      />
    )
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onClose).toHaveBeenCalled()
    expect(window.argus.jira.ingestAttachments).not.toHaveBeenCalled()
    expect(window.argus.jira.setAttachmentSelection).not.toHaveBeenCalled()
  })

  it('disables Cancel while the confirm persist is in flight', async () => {
    const user = userEvent.setup()
    // never resolves: keeps the dialog in its busy state for the assertion
    window.argus.jira.setAttachmentSelection = vi.fn(() => new Promise(() => {})) as never
    render(
      <JiraAttachmentsDialog
        slug="NAV-7"
        groups={[primary({ newAttachments: [att('1', 'new.txt')] })]}
        onClose={() => {}}
      />
    )
    await user.click(screen.getByRole('button', { name: /download selected/i }))
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /download selected/i })).toBeDisabled()
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    render(
      <JiraAttachmentsDialog
        slug="NAV-7"
        groups={[primary({ newAttachments: [att('1', 'new.txt')] })]}
        onClose={onClose}
      />
    )
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close on Escape while busy', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    // never resolves: keeps the dialog in its busy state for the assertion
    window.argus.jira.setAttachmentSelection = vi.fn(() => new Promise(() => {})) as never
    render(
      <JiraAttachmentsDialog
        slug="NAV-7"
        groups={[primary({ newAttachments: [att('1', 'new.txt')] })]}
        onClose={onClose}
      />
    )
    await user.click(screen.getByRole('button', { name: /download selected/i }))
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders one group per ticket and ingests each with its own key', async () => {
    render(
      <JiraAttachmentsDialog
        slug="NAV-7"
        groups={[
          primary({ newAttachments: [att('1', 'own.log')] }),
          source({ newAttachments: [att('2', 'cust.log')] })
        ]}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText('NAV-7')).toBeInTheDocument()
    expect(screen.getByText('CUST-9')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /download selected/i }))

    await waitFor(() =>
      expect(window.argus.jira.ingestAttachments).toHaveBeenCalledWith(
        'NAV-7',
        'NAV-7',
        expect.arrayContaining([expect.objectContaining({ id: '1' })])
      )
    )
    expect(window.argus.jira.ingestAttachments).toHaveBeenCalledWith(
      'NAV-7',
      'CUST-9',
      expect.arrayContaining([expect.objectContaining({ id: '2' })])
    )
  })

  it('persists an unchecked source attachment as declined for that source', async () => {
    render(
      <JiraAttachmentsDialog
        slug="NAV-7"
        groups={[source({ newAttachments: [att('2', 'cust.log')] })]}
        onClose={vi.fn()}
      />
    )

    await userEvent.click(screen.getByRole('checkbox', { name: /cust\.log/i }))
    await userEvent.click(screen.getByRole('button', { name: /download selected/i }))

    await waitFor(() =>
      expect(window.argus.jira.setSourceAttachmentSelection).toHaveBeenCalledWith(
        'NAV-7',
        'CUST-9',
        ['2']
      )
    )
    expect(window.argus.jira.setAttachmentSelection).not.toHaveBeenCalled()
    expect(window.argus.jira.ingestAttachments).not.toHaveBeenCalled()
  })

  it('stops at the first group whose persist fails, before ingesting anything', async () => {
    window.argus.jira.setAttachmentSelection = vi.fn(async () => ({
      ok: false,
      code: 'network',
      message: 'offline'
    })) as never
    const onClose = vi.fn()
    render(
      <JiraAttachmentsDialog
        slug="NAV-7"
        groups={[
          primary({ newAttachments: [att('1', 'own.log')] }),
          source({ newAttachments: [att('2', 'cust.log')] })
        ]}
        onClose={onClose}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /download selected/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/offline/i)
    expect(window.argus.jira.ingestAttachments).not.toHaveBeenCalled()
    expect(window.argus.jira.setSourceAttachmentSelection).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
