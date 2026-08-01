// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaseAnchor } from '../CaseAnchor'
import { uiStore } from '../../lib/uiStore'
import { noticeStore } from '../../lib/noticeStore'

beforeEach(() => {
  noticeStore.reset()
  for (const t of [...uiStore.get().recentTabs]) uiStore.closeTab(t)
  const setStatusMock = vi.fn()
  setStatusMock.mockResolvedValue(undefined)
  const exportMock = vi.fn()
  exportMock.mockResolvedValue({ ok: true, fileCount: 12 })
  const statusMock = vi.fn()
  statusMock.mockResolvedValue(null)
  const onChangedMock = vi.fn()
  onChangedMock.mockReturnValue(() => {})
  const redistillMock = vi.fn()
  redistillMock.mockResolvedValue(undefined)
  window.argus = {
    cases: { setStatus: setStatusMock },
    bundle: { export: exportMock },
    distill: {
      status: statusMock,
      onChanged: onChangedMock,
      redistill: redistillMock
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
    expect(screen.getByText('Re-distill')).toBeTruthy()
    expect(screen.getByText('Close case')).toBeTruthy()
  })

  it('doubles the Close as… row as the status readout for a closed case', async () => {
    const user = userEvent.setup()
    renderAnchor({ status: 'closed', resolution: 'solved' })
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    expect(screen.getByText('Closed · solved')).toBeTruthy()
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
    fireEvent.click(screen.getByText('Close as…'))
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
    fireEvent.click(screen.getByText('Export'))
    fireEvent.click(screen.getByText('Export case…'))
    await vi.waitFor(() => expect(noticeStore.get().notices).toHaveLength(1))
    expect(noticeStore.get().notices[0].message).toBe('exported 12 files')
  })

  it('disables Re-distill until the case is closed', async () => {
    const user = userEvent.setup()
    renderAnchor({ status: 'open' })
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    const row = screen.getByText('Re-distill').closest('button')
    expect(row?.hasAttribute('disabled')).toBe(true)
  })
})
