// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { JiraAttachmentsDialog } from '../JiraAttachmentsDialog'
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

beforeEach(() => {
  window.argus = {
    jira: {
      ingestAttachments: vi.fn(async () => ({ ok: true, value: [] })),
      setAttachmentSelection: vi.fn(async () => ({ ok: true, value: {} }))
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
      <JiraAttachmentsDialog
        slug="NAV-7"
        newAttachments={[]}
        deselectedAttachments={[]}
        ingestedAttachments={[]}
        onClose={() => {}}
      />
    )
    expect(panelsStore.get().occluded).toBe(true)
    unmount()
    expect(panelsStore.get().occluded).toBe(false)
  })

  it('pre-checks new attachments and leaves previously deselected unchecked', () => {
    render(
      <JiraAttachmentsDialog
        slug="NAV-7"
        newAttachments={[att('1', 'new.txt')]}
        deselectedAttachments={[att('2', 'old.txt')]}
        ingestedAttachments={[]}
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
        newAttachments={[att('1', 'new.txt')]}
        deselectedAttachments={[]}
        ingestedAttachments={[att('9', 'synced.txt')]}
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
    expect(window.argus.jira.ingestAttachments).toHaveBeenCalledWith('NAV-7', [
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
        newAttachments={[att('1', 'new.txt')]}
        deselectedAttachments={[att('2', 'old.txt')]}
        ingestedAttachments={[]}
        onClose={onClose}
      />
    )
    await user.click(screen.getByRole('button', { name: /download selected/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(window.argus.jira.ingestAttachments).toHaveBeenCalledWith('NAV-7', [
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
        newAttachments={[att('1', 'new.txt')]}
        deselectedAttachments={[att('2', 'old.txt')]}
        ingestedAttachments={[att('9', 'synced.txt')]}
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

  it('hides the toggle when every row is already synced', () => {
    render(
      <JiraAttachmentsDialog
        slug="NAV-7"
        newAttachments={[]}
        deselectedAttachments={[]}
        ingestedAttachments={[att('9', 'synced.txt')]}
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
        newAttachments={[
          typed('1', 'b.txt', 'text/plain'),
          typed('2', 'dump.bin', 'application/octet-stream'),
          typed('3', 'a.txt', 'text/plain')
        ]}
        deselectedAttachments={[typed('4', 'skipped.txt', 'text/plain')]}
        ingestedAttachments={[typed('5', 'synced.txt', 'text/plain')]}
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
        newAttachments={[att('1', 'new.txt')]}
        deselectedAttachments={[]}
        ingestedAttachments={[]}
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
        newAttachments={[att('1', 'new.txt')]}
        deselectedAttachments={[]}
        ingestedAttachments={[]}
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
        newAttachments={[att('1', 'new.txt')]}
        deselectedAttachments={[]}
        ingestedAttachments={[]}
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
        newAttachments={[att('1', 'new.txt')]}
        deselectedAttachments={[]}
        ingestedAttachments={[]}
        onClose={onClose}
      />
    )
    await user.click(screen.getByRole('button', { name: /download selected/i }))
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })
})
