// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { JiraAttachmentsDialog } from '../JiraAttachmentsDialog'
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

describe('JiraAttachmentsDialog', () => {
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
})
