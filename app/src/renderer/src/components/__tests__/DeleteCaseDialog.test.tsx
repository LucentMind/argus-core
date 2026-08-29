// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { DeleteCaseDialog } from '../DeleteCaseDialog'
import { __resetEscapeLayersForTest } from '../../lib/escapeLayer'

afterEach(() => __resetEscapeLayersForTest())

let archiveSizeMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  archiveSizeMock = vi.fn()
  // 412.0 MB exactly, so the assertions below name a number a human would read off the dialog
  // rather than a rounding artefact.
  archiveSizeMock.mockResolvedValue(431_984_640)
  window.argus = {
    cases: { delete: vi.fn(async () => undefined), archiveSize: archiveSizeMock }
  } as never
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

  it('names the bundle’s actual size, read off disk', async () => {
    // Spec §7: the archived branch "states the bundle's actual size" — a confirmation that does
    // not name what it destroys is not a confirmation. "the archive bundle" alone let the
    // operator press "Delete everything" with no idea whether that was 4 MB or 4 GB.
    render(
      <DeleteCaseDialog
        slug="C-1"
        archivedAt="2026-08-28T00:00:00Z"
        onCancel={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    const body = await screen.findByText(/412\.0 MB/)
    expect(body.textContent).toMatch(/archive bundle \(412\.0 MB\)/)
    // Off the FILE, for this slug — not off `CaseRecord`, which carries a path and no size.
    expect(archiveSizeMock).toHaveBeenCalledWith('C-1')
  })

  it('says a kept bundle only comes back as a NEW case', async () => {
    // Spec §7 again: the bundle is "recoverable later only through importCase, i.e. as a new
    // case, which the dialog says". "Keep the archive" otherwise reads as an undo.
    render(
      <DeleteCaseDialog
        slug="C-1"
        archivedAt="2026-08-28T00:00:00Z"
        onCancel={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    const body = await screen.findByText(/archive bundle/i)
    expect(body.textContent).toMatch(/importing it, as a new case, never as this one/i)
  })

  it('shows the plain noun while the size is still being weighed, not the no-longer-on-disk copy', async () => {
    // Three states, not two: `undefined` (still loading) must render distinctly from `null` (no
    // honest number, e.g. the file is gone). Since the size always arrives over IPC, this loading
    // render is what every user sees on first paint — collapsing it into the `null` copy would
    // tell the operator the bundle is missing before the lookup has even returned.
    let resolveSize: (n: number | null) => void = () => {}
    archiveSizeMock.mockReturnValue(
      new Promise<number | null>((resolve) => {
        resolveSize = resolve
      })
    )
    render(
      <DeleteCaseDialog
        slug="C-1"
        archivedAt="2026-08-28T00:00:00Z"
        onCancel={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    const body = screen.getByText(/archive bundle/i)
    expect(body.textContent).toMatch(/in the archive bundle:/)
    expect(body.textContent).not.toMatch(/no longer on disk|MB/)
    resolveSize(431_984_640)
    await screen.findByText(/412\.0 MB/)
  })

  it('degrades to size-free copy when the bundle is not on disk', async () => {
    // `archiveSize` answers null when there is no file to stat — an archived row whose zip was
    // moved or removed behind the app's back. The dialog must say so, not render "undefined MB".
    archiveSizeMock.mockResolvedValue(null)
    render(
      <DeleteCaseDialog
        slug="C-1"
        archivedAt="2026-08-28T00:00:00Z"
        onCancel={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    const body = await screen.findByText(/no longer on disk/i)
    expect(body.textContent).not.toMatch(/undefined|null|NaN/)
    // Still fully operable: the archive choice is exactly what clears a stale row.
    expect(screen.getByRole('button', { name: 'Delete everything' })).toBeInTheDocument()
  })

  it('degrades the same way when the size lookup itself fails', async () => {
    archiveSizeMock.mockRejectedValue(new Error('EPERM'))
    render(
      <DeleteCaseDialog
        slug="C-1"
        archivedAt="2026-08-28T00:00:00Z"
        onCancel={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    const body = await screen.findByText(/no longer on disk/i)
    expect(body.textContent).not.toMatch(/undefined|null|NaN/)
  })

  it('asks for no size on a case that was never archived', async () => {
    render(<DeleteCaseDialog slug="C-1" onCancel={vi.fn()} onDeleted={vi.fn()} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(archiveSizeMock).not.toHaveBeenCalled()
    expect(screen.queryByText(/MB|no longer on disk/)).toBeNull()
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
