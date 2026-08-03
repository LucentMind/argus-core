// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaseAnchor } from '../CaseAnchor'
import { uiStore } from '../../lib/uiStore'
import { noticeStore } from '../../lib/noticeStore'
import type { DistillJobRow } from '../../../../shared/distill'

let statusMock: ReturnType<typeof vi.fn>
let redistillMock: ReturnType<typeof vi.fn>
let cancelMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  noticeStore.reset()
  for (const t of [...uiStore.get().recentTabs]) uiStore.closeTab(t)
  const setStatusMock = vi.fn()
  setStatusMock.mockResolvedValue(undefined)
  const exportMock = vi.fn()
  exportMock.mockResolvedValue({ ok: true, fileCount: 12 })
  statusMock = vi.fn()
  statusMock.mockResolvedValue(null)
  const onChangedMock = vi.fn()
  onChangedMock.mockReturnValue(() => {})
  redistillMock = vi.fn()
  redistillMock.mockResolvedValue(undefined)
  cancelMock = vi.fn()
  cancelMock.mockResolvedValue(undefined)
  window.argus = {
    cases: { setStatus: setStatusMock },
    bundle: { export: exportMock },
    distill: {
      status: statusMock,
      onChanged: onChangedMock,
      redistill: redistillMock,
      cancel: cancelMock
    }
  } as never
})

function renderAnchor(overrides?: {
  status?: 'open' | 'closed'
  resolution?: string | null
  onStatusChanged?: () => void
  onHome?: () => void
}): void {
  render(
    <CaseAnchor
      slug="NN-5187"
      status={(overrides?.status ?? 'open') as never}
      resolution={(overrides?.resolution ?? null) as never}
      onStatusChanged={overrides?.onStatusChanged ?? vi.fn()}
      onHome={overrides?.onHome ?? vi.fn()}
    />
  )
}

describe('CaseAnchor', () => {
  it('shows the slug beside its actions trigger, not as the trigger', async () => {
    renderAnchor()
    expect(screen.getByText('NN-5187')).toBeTruthy()
    // A caret next to a case id promises a list of cases; this menu acts on one case.
    const trigger = screen.getByRole('button', { name: 'Case actions · NN-5187' })
    expect(trigger.textContent).not.toContain('▾')
  })

  it('opens the case actions', async () => {
    const user = userEvent.setup()
    renderAnchor()
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    expect(screen.getByText('Close as…')).toBeTruthy()
    expect(screen.getByText('Export')).toBeTruthy()
    expect(screen.getByText('Distill')).toBeTruthy()
    expect(screen.getByText('Close case')).toBeTruthy()
  })

  it('doubles the Close as… row as the status readout for a closed case', async () => {
    const user = userEvent.setup()
    renderAnchor({ status: 'closed', resolution: 'solved' })
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    expect(screen.getByText('Closed · solved')).toBeTruthy()
  })

  it('shows a bare Closed label for a legacy closed case with no resolution', async () => {
    const user = userEvent.setup()
    renderAnchor({ status: 'closed', resolution: null })
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    expect(screen.getByText('Closed')).toBeTruthy()
    expect(screen.queryByText('Close as…')).toBeNull()
  })

  it('reopens a closed case from the Reopen row nested under the status readout', async () => {
    const user = userEvent.setup()
    const onStatusChanged = vi.fn()
    renderAnchor({ status: 'closed', resolution: 'solved', onStatusChanged })
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    // "Closed · solved" is the parent row that opens the resolution submenu; drive it with
    // userEvent per the hover-submenu convention.
    await user.click(screen.getByText('Closed · solved'))
    await vi.waitFor(() => expect(screen.getByText('Reopen')).toBeTruthy())
    // "Reopen" is a leaf item inside the now-open submenu; drive it with fireEvent.
    fireEvent.click(screen.getByText('Reopen'))
    await vi.waitFor(() =>
      expect(window.argus.cases.setStatus).toHaveBeenCalledWith('NN-5187', 'open', null)
    )
    await vi.waitFor(() => expect(onStatusChanged).toHaveBeenCalled())
  })

  it('closes the tab and navigates home from Close case', async () => {
    const user = userEvent.setup()
    const onHome = vi.fn()
    uiStore.openTab('NN-5187')
    renderAnchor({ onHome })
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    await user.click(screen.getByText('Close case'))
    expect(uiStore.get().recentTabs).toEqual([])
    expect(onHome).toHaveBeenCalled()
  })

  it('applies a resolution and tells the parent to refetch', async () => {
    const user = userEvent.setup()
    const onStatusChanged = vi.fn()
    renderAnchor({ onStatusChanged })
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    await user.click(screen.getByText('Close as…'))
    await vi.waitFor(() => expect(screen.getByText('solved')).toBeTruthy())
    fireEvent.click(screen.getByText('solved'))
    await vi.waitFor(() =>
      expect(window.argus.cases.setStatus).toHaveBeenCalledWith('NN-5187', 'closed', 'solved')
    )
    await vi.waitFor(() => expect(onStatusChanged).toHaveBeenCalled())
  })

  it('reports a finished export as a notice, not as anchor text', async () => {
    const user = userEvent.setup()
    renderAnchor()
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    await user.click(screen.getByText('Export'))
    fireEvent.click(screen.getByText('Export case…'))
    await vi.waitFor(() => expect(noticeStore.get().notices).toHaveLength(1))
    expect(noticeStore.get().notices[0].message).toBe('exported 12 files')
  })

  it('stays silent when the export save dialog is cancelled', async () => {
    const user = userEvent.setup()
    ;(window.argus.bundle.export as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    renderAnchor()
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    // "Export" is the parent row that opens the submenu; drive it with userEvent.
    await user.click(screen.getByText('Export'))
    // "Export case…" is a leaf item inside the now-open submenu; drive it with fireEvent.
    fireEvent.click(screen.getByText('Export case…'))
    await vi.waitFor(() => expect(window.argus.bundle.export).toHaveBeenCalled())
    // No positive signal to wait on when the dialog is cancelled (that is the point of the
    // test) — flush the awaited `window.argus.bundle.export()` microtask so `exportBundle`'s
    // `if (!r) return` has actually run before asserting nothing was queued.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(noticeStore.get().notices).toHaveLength(0)
  })

  it('offers Distill on an open, never-distilled case', async () => {
    const user = userEvent.setup()
    renderAnchor({ status: 'open' })
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    const row = screen.getByText('Distill').closest('button')
    expect(row?.hasAttribute('disabled')).toBe(false)
    await user.click(row!)
    expect(redistillMock).toHaveBeenCalledWith('NN-5187')
    expect(cancelMock).not.toHaveBeenCalled()
  })

  it('F7: a second click while the first redistill response is in flight does not issue a second redistill', async () => {
    let resolveRedistill: (value: DistillJobRow) => void
    const pendingPromise = new Promise<DistillJobRow>((resolve) => {
      resolveRedistill = resolve
    })
    redistillMock.mockReturnValue(pendingPromise)
    const user = userEvent.setup()
    renderAnchor({ status: 'open' })

    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    await user.click(screen.getByText('Distill').closest('button')!)
    expect(redistillMock).toHaveBeenCalledTimes(1)

    // Reopen the menu and click again before the first redistill() response has landed.
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    await user.click(screen.getByText('Distill').closest('button')!)
    expect(redistillMock).toHaveBeenCalledTimes(1) // still just once — the pending guard held

    resolveRedistill!({
      id: 9,
      caseSlug: 'NN-5187',
      state: 'queued',
      error: null,
      itemCount: null,
      createdAt: 't',
      finishedAt: null
    })
  })

  it('F7: adopts cancel()/redistill() responses optimistically, like DistillChip, instead of depending solely on the broadcast', async () => {
    // CaseAnchor used to discard cancel()'s response and rely entirely on the broadcast, which
    // DistillQueue.emit() deliberately swallows failures from — on a swallowed broadcast the
    // menu row would stay on "Cancel distillation" for an already-cancelled job.
    cancelMock.mockResolvedValue({
      id: 7,
      caseSlug: 'NN-5187',
      state: 'cancelled',
      error: null,
      itemCount: null,
      createdAt: 't',
      finishedAt: 't2'
    })
    statusMock.mockResolvedValue({
      id: 7,
      caseSlug: 'NN-5187',
      state: 'running',
      error: null,
      itemCount: null,
      createdAt: 't',
      finishedAt: null
    })
    const user = userEvent.setup()
    renderAnchor({ status: 'open' })
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    const row = await screen.findByText('Cancel distillation')
    await user.click(row.closest('button')!)
    expect(cancelMock).toHaveBeenCalledWith(7)

    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    // The optimistic cancel() response (state: 'cancelled') must flip the row without a
    // broadcast ever arriving — distillMenuLabel of a resting, non-'done' job is 'Re-distill'.
    await screen.findByText('Re-distill')
  })

  it('flips the row to Cancel distillation while a job is running', async () => {
    statusMock.mockResolvedValue({
      id: 7,
      caseSlug: 'NN-5187',
      state: 'running',
      error: null,
      itemCount: null,
      createdAt: 't',
      finishedAt: null
    })
    const user = userEvent.setup()
    renderAnchor({ status: 'open' })
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    const row = await screen.findByText('Cancel distillation')
    await user.click(row.closest('button')!)
    expect(cancelMock).toHaveBeenCalledWith(7)
    expect(redistillMock).not.toHaveBeenCalled()
  })
})
