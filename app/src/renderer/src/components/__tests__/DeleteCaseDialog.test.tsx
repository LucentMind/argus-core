// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { DeleteCaseDialog } from '../DeleteCaseDialog'
import { __resetEscapeLayersForTest } from '../../lib/escapeLayer'

afterEach(() => __resetEscapeLayersForTest())

beforeEach(() => {
  window.argus = { cases: { delete: vi.fn(async () => undefined) } } as never
})

describe('DeleteCaseDialog', () => {
  it('Escape cancels immediately from the confirm field, even with text typed', async () => {
    const onCancel = vi.fn()
    render(<DeleteCaseDialog slug="C-1" onCancel={onCancel} onDeleted={vi.fn()} />)
    const field = screen.getByLabelText('Confirm slug')
    await userEvent.type(field, 'C-')
    expect(field).toHaveFocus() // autoFocus + typing: Escape lands on a field
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Escape cancels from the confirm field when it is empty', async () => {
    const onCancel = vi.fn()
    render(<DeleteCaseDialog slug="C-1" onCancel={onCancel} onDeleted={vi.fn()} />)
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Escape closes the dialog without deleting when focus is off the field', async () => {
    const onCancel = vi.fn()
    render(<DeleteCaseDialog slug="C-1" onCancel={onCancel} onDeleted={vi.fn()} />)
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
  })
})

describe('DeleteCaseDialog: what the delete actually destroys', () => {
  // Archiving made "what a delete destroys" case-dependent, and this dialog's one sentence
  // ("Permanently deletes the case, its evidence, chats, and findings") became false for an
  // archived case: `cases.delete` defaults `deleteArchive` to false, so the bundle holding
  // exactly that evidence and those chats survived in <argusHome>/archive/. From the dashboard —
  // the only surface a LISTED case can be deleted from — that bundle could then never be
  // removed, and with the row gone the case appeared nowhere at all.
  async function type(slug: string): Promise<void> {
    await userEvent.type(screen.getByLabelText('Confirm slug'), slug)
  }

  it('offers both archive outcomes on an archived case and forwards the one picked', async () => {
    render(
      <DeleteCaseDialog
        slug="C-1"
        archivedAt="2026-08-28T00:00:00Z"
        onCancel={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    expect(screen.getByText(/archive bundle/i)).toBeInTheDocument()
    await type('C-1')
    // Asserted on the ARGUMENT, not on the call: a test that only checked `delete` was called
    // would pass with the two buttons wired to the same value.
    await userEvent.click(screen.getByRole('button', { name: 'Keep the archive' }))
    expect(window.argus.cases.delete).toHaveBeenCalledWith('C-1', { deleteArchive: false })
  })

  it('deletes the bundle too when the operator asks for everything', async () => {
    render(
      <DeleteCaseDialog
        slug="C-1"
        archivedAt="2026-08-28T00:00:00Z"
        onCancel={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    await type('C-1')
    await userEvent.click(screen.getByRole('button', { name: 'Delete everything' }))
    expect(window.argus.cases.delete).toHaveBeenCalledWith('C-1', { deleteArchive: true })
  })

  it('keeps the single-action shape on a case that was never archived', async () => {
    render(<DeleteCaseDialog slug="C-1" onCancel={vi.fn()} onDeleted={vi.fn()} />)
    // No bundle exists, so there is no second question — and the copy must not imply one.
    expect(screen.queryByRole('button', { name: 'Keep the archive' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete everything' })).toBeNull()
    expect(screen.getByText(/no archive bundle for this case/i)).toBeInTheDocument()
    await type('C-1')
    await userEvent.click(screen.getByRole('button', { name: 'Delete case' }))
    // `false`, not `true`: there is no bundle, and the flag says what it means.
    expect(window.argus.cases.delete).toHaveBeenCalledWith('C-1', { deleteArchive: false })
  })

  it('still requires the slug before either archived action is live', async () => {
    render(
      <DeleteCaseDialog
        slug="C-1"
        archivedAt="2026-08-28T00:00:00Z"
        onCancel={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Keep the archive' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete everything' })).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Confirm slug'), 'C-')
    expect(screen.getByRole('button', { name: 'Delete everything' })).toBeDisabled()
  })

  it('takes the archive-keeping branch on Enter, never the lossy one', async () => {
    // Losing the bundle must be a deliberate click. Enter is a habit key.
    render(
      <DeleteCaseDialog
        slug="C-1"
        archivedAt="2026-08-28T00:00:00Z"
        onCancel={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    await type('C-1')
    await userEvent.keyboard('{Enter}')
    expect(window.argus.cases.delete).toHaveBeenCalledWith('C-1', { deleteArchive: false })
  })
})
