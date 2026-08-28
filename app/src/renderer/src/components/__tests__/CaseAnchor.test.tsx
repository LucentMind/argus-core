// @vitest-environment jsdom
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaseAnchor } from '../CaseAnchor'
import { ConfirmHost } from '../ConfirmHost'
import { uiStore } from '../../lib/uiStore'
import { noticeStore } from '../../lib/noticeStore'
import type { DistillJobRow, DistillStatusPayload } from '../../../../shared/distill'

let statusMock: ReturnType<typeof vi.fn>
let redistillMock: ReturnType<typeof vi.fn>
let cancelMock: ReturnType<typeof vi.fn>
let needsRunMock: ReturnType<typeof vi.fn>
let deleteMock: ReturnType<typeof vi.fn>
let archiveMock: ReturnType<typeof vi.fn>
let restoreMock: ReturnType<typeof vi.fn>

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
  needsRunMock = vi.fn()
  needsRunMock.mockResolvedValue(true)
  deleteMock = vi.fn()
  deleteMock.mockResolvedValue(undefined)
  archiveMock = vi.fn()
  archiveMock.mockResolvedValue({ slug: 'NN-5187', bundlePath: '/a/NN-5187.zip' })
  restoreMock = vi.fn()
  restoreMock.mockResolvedValue({ slug: 'NN-5187' })
  window.argus = {
    cases: {
      setStatus: setStatusMock,
      delete: deleteMock,
      archive: archiveMock,
      restore: restoreMock
    },
    bundle: { export: exportMock },
    distill: {
      status: statusMock,
      onChanged: onChangedMock,
      redistill: redistillMock,
      cancel: cancelMock,
      needsRun: needsRunMock
    }
  } as never
})

function renderAnchor(overrides?: {
  status?: 'open' | 'closed'
  resolution?: string | null
  archivedAt?: string | null
  onStatusChanged?: () => void
  onHome?: () => void
}): void {
  render(
    <>
      <CaseAnchor
        slug="NN-5187"
        status={(overrides?.status ?? 'open') as never}
        resolution={(overrides?.resolution ?? null) as never}
        archivedAt={overrides?.archivedAt ?? null}
        onStatusChanged={overrides?.onStatusChanged ?? vi.fn()}
        onHome={overrides?.onHome ?? vi.fn()}
      />
      <ConfirmHost />
    </>
  )
}

/** The menu trigger is the case id itself — see the anchor's own docblock. */
async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
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
      expect(window.argus.cases.setStatus).toHaveBeenCalledWith('NN-5187', 'open', null, true)
    )
    await vi.waitFor(() => expect(onStatusChanged).toHaveBeenCalled())
  })

  it('re-resolves an already-closed case directly, with no confirm dialog or distill checkbox', async () => {
    const user = userEvent.setup()
    const onStatusChanged = vi.fn()
    renderAnchor({ status: 'closed', resolution: 'solved', onStatusChanged })
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    // "Closed · solved" is the parent row that opens the resolution submenu; drive it with
    // userEvent per the hover-submenu convention.
    await user.click(screen.getByText('Closed · solved'))
    await vi.waitFor(() => expect(screen.getByText('duplicate')).toBeTruthy())
    // "duplicate" is a leaf item inside the now-open submenu; drive it with fireEvent.
    fireEvent.click(screen.getByText('duplicate'))
    await vi.waitFor(() =>
      expect(window.argus.cases.setStatus).toHaveBeenCalledWith(
        'NN-5187',
        'closed',
        'duplicate',
        true
      )
    )
    await vi.waitFor(() => expect(onStatusChanged).toHaveBeenCalled())
    expect(screen.queryByText(/Close case as/)).toBeNull()
    expect(screen.queryByLabelText('Start distillation')).toBeNull()
    expect(needsRunMock).not.toHaveBeenCalled()
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
    await screen.findByText('Close case as solved?')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await vi.waitFor(() =>
      expect(window.argus.cases.setStatus).toHaveBeenCalledWith('NN-5187', 'closed', 'solved', true)
    )
    await vi.waitFor(() => expect(onStatusChanged).toHaveBeenCalled())
  })

  it('preselects the distill checkbox unchecked when needsRun resolves false, and honors it', async () => {
    needsRunMock.mockResolvedValue(false)
    const user = userEvent.setup()
    renderAnchor()
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    await user.click(screen.getByText('Close as…'))
    await vi.waitFor(() => expect(screen.getByText('solved')).toBeTruthy())
    fireEvent.click(screen.getByText('solved'))
    const checkbox = (await screen.findByLabelText('Start distillation')) as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await vi.waitFor(() =>
      expect(window.argus.cases.setStatus).toHaveBeenCalledWith(
        'NN-5187',
        'closed',
        'solved',
        false
      )
    )
  })

  it('lets the user uncheck a preselected-checked distill checkbox before confirming', async () => {
    needsRunMock.mockResolvedValue(true)
    const user = userEvent.setup()
    renderAnchor()
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    await user.click(screen.getByText('Close as…'))
    await vi.waitFor(() => expect(screen.getByText('solved')).toBeTruthy())
    fireEvent.click(screen.getByText('solved'))
    const checkbox = (await screen.findByLabelText('Start distillation')) as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await vi.waitFor(() =>
      expect(window.argus.cases.setStatus).toHaveBeenCalledWith(
        'NN-5187',
        'closed',
        'solved',
        false
      )
    )
  })

  it('cancelling the close confirmation closes nothing', async () => {
    const user = userEvent.setup()
    renderAnchor()
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    await user.click(screen.getByText('Close as…'))
    await vi.waitFor(() => expect(screen.getByText('solved')).toBeTruthy())
    fireEvent.click(screen.getByText('solved'))
    await screen.findByText('Close case as solved?')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(window.argus.cases.setStatus).not.toHaveBeenCalled()
  })

  it('defaults to checked (fail open) when needsRun rejects', async () => {
    needsRunMock.mockRejectedValue(new Error('boom'))
    const user = userEvent.setup()
    renderAnchor()
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    await user.click(screen.getByText('Close as…'))
    await vi.waitFor(() => expect(screen.getByText('solved')).toBeTruthy())
    fireEvent.click(screen.getByText('solved'))
    const checkbox = (await screen.findByLabelText('Start distillation')) as HTMLInputElement
    expect(checkbox.checked).toBe(true)
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
      finishedAt: null,
      costUsd: null,
      turnCount: null,
      toolCallCount: null,
      promptChars: null,
      dryRun: false
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
      finishedAt: 't2',
      dryRun: false
    })
    statusMock.mockResolvedValue({
      id: 7,
      caseSlug: 'NN-5187',
      state: 'running',
      error: null,
      itemCount: null,
      createdAt: 't',
      finishedAt: null,
      dryRun: false
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
      finishedAt: null,
      dryRun: false
    })
    const user = userEvent.setup()
    renderAnchor({ status: 'open' })
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    const row = await screen.findByText('Cancel distillation')
    await user.click(row.closest('button')!)
    expect(cancelMock).toHaveBeenCalledWith(7)
    expect(redistillMock).not.toHaveBeenCalled()
  })

  it('F1: a stale cancel() response arriving after a broadcast for a newer job must not flip the row to Re-distill (regression)', async () => {
    // Mirrors DistillChip's "a later broadcast for a newer job supersedes a stale optimistic
    // cancel result" test. Job 7 is running; the user clicks Cancel. Before cancel(7)'s response
    // lands, a broadcast for job 8 arrives (e.g. the case was closed from another window, which
    // cancels 7 and enqueues 8) — the row correctly flips to show job 8 is running. Job 7's stale
    // 'cancelled' response must not then overwrite that with 'Re-distill', which would make a
    // click on it call redistill(slug) and enqueue a second in-flight job for job 8's slug.
    let onChangedCb: ((p: DistillStatusPayload) => void) | undefined
    let resolveCancel: (value: DistillJobRow) => void
    const cancelPromise = new Promise<DistillJobRow>((resolve) => {
      resolveCancel = resolve
    })
    cancelMock.mockReturnValue(cancelPromise)
    statusMock.mockResolvedValue({
      id: 7,
      caseSlug: 'NN-5187',
      state: 'running',
      error: null,
      itemCount: null,
      createdAt: 't',
      finishedAt: null,
      dryRun: false
    })
    window.argus = {
      cases: { setStatus: vi.fn().mockResolvedValue(undefined) },
      bundle: { export: vi.fn().mockResolvedValue({ ok: true, fileCount: 0 }) },
      distill: {
        status: statusMock,
        onChanged: vi.fn((cb: (p: DistillStatusPayload) => void) => {
          onChangedCb = cb
          return () => undefined
        }),
        redistill: redistillMock,
        cancel: cancelMock
      }
    } as never

    const user = userEvent.setup()
    renderAnchor({ status: 'open' })
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    const row = await screen.findByText('Cancel distillation')
    await user.click(row.closest('button')!)
    expect(cancelMock).toHaveBeenCalledWith(7)

    // Job 8's broadcast lands before job 7's cancel() response does.
    act(() => {
      onChangedCb?.({
        caseSlug: 'NN-5187',
        job: {
          id: 8,
          caseSlug: 'NN-5187',
          state: 'running',
          error: null,
          itemCount: null,
          createdAt: 't',
          finishedAt: null,
          costUsd: null,
          turnCount: null,
          toolCallCount: null,
          promptChars: null,
          dryRun: false
        }
      })
    })

    // Job 7's stale cancel() response now resolves.
    await act(async () => {
      resolveCancel!({
        id: 7,
        caseSlug: 'NN-5187',
        state: 'cancelled',
        error: null,
        itemCount: null,
        createdAt: 't',
        finishedAt: 't2',
        costUsd: null,
        turnCount: null,
        toolCallCount: null,
        promptChars: null,
        dryRun: false
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    await screen.findByText('Cancel distillation')
    expect(screen.queryByText('Re-distill')).toBeNull()
  })

  it('N5: a broadcast resets a pending menu action, so a redistill()/cancel() promise that never settles does not leave the row inert forever (DistillChip already does this for its `cancelling` flag)', async () => {
    let onChangedCb: ((p: DistillStatusPayload) => void) | undefined
    redistillMock.mockReturnValue(new Promise<DistillJobRow>(() => {})) // never settles
    window.argus = {
      cases: { setStatus: vi.fn().mockResolvedValue(undefined) },
      bundle: { export: vi.fn().mockResolvedValue({ ok: true, fileCount: 0 }) },
      distill: {
        status: statusMock,
        onChanged: vi.fn((cb: (p: DistillStatusPayload) => void) => {
          onChangedCb = cb
          return () => undefined
        }),
        redistill: redistillMock,
        cancel: cancelMock
      }
    } as never

    const user = userEvent.setup()
    renderAnchor({ status: 'open' })
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    await user.click(screen.getByText('Distill').closest('button')!)
    expect(redistillMock).toHaveBeenCalledTimes(1)

    // A broadcast lands regardless — e.g. another window started a distill for this case. The
    // menu row's own `redistill()` call never settles, so nothing in the click handler itself
    // ever clears `pending`.
    act(() => {
      onChangedCb?.({
        caseSlug: 'NN-5187',
        job: {
          id: 9,
          caseSlug: 'NN-5187',
          state: 'running',
          error: null,
          itemCount: null,
          createdAt: 't',
          finishedAt: null,
          costUsd: null,
          turnCount: null,
          toolCallCount: null,
          promptChars: null,
          dryRun: false
        }
      })
    })

    // Without resetting `pending` alongside `override`, the row would still ignore clicks here —
    // `distillMenuLabel` correctly reads "Cancel distillation" off the broadcast, but the guard
    // (`if (pending) return`) would swallow the click before `cancel()` is ever called.
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    await user.click(screen.getByText('Cancel distillation').closest('button')!)
    expect(cancelMock).toHaveBeenCalledWith(9)
  })

  it('starts a dry run with ignorePriorProposals from the menu', async () => {
    const dryRunMock = vi.fn().mockResolvedValue(null)
    window.argus.distill.dryRun = dryRunMock
    const user = userEvent.setup()
    renderAnchor({ status: 'open' })
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    await user.click(screen.getByText('Dry run (compare)…'))
    await vi.waitFor(() => expect(dryRunMock).toHaveBeenCalledWith('NN-5187', true))
  })

  it('F3: disables Dry run (compare)… while a REAL distillation is running, instead of silently cancelling it (regression: clicking it cancelled the running real job)', async () => {
    const dryRunMock = vi.fn().mockResolvedValue(null)
    statusMock.mockResolvedValue({
      id: 1,
      caseSlug: 'NN-5187',
      state: 'running',
      error: null,
      itemCount: null,
      createdAt: 't',
      finishedAt: null,
      dryRun: false
    })
    window.argus = {
      cases: { setStatus: vi.fn().mockResolvedValue(undefined) },
      bundle: { export: vi.fn().mockResolvedValue({ ok: true, fileCount: 0 }) },
      distill: {
        status: statusMock,
        onChanged: vi.fn().mockReturnValue(() => undefined),
        redistill: redistillMock,
        cancel: cancelMock,
        dryRun: dryRunMock
      }
    } as never
    const user = userEvent.setup()
    renderAnchor({ status: 'open' })
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    await screen.findByText('Cancel distillation') // sanity: the real job is being tracked as running

    const row = screen.getByText('Dry run (compare)…').closest('button')!
    expect(row.hasAttribute('disabled')).toBe(true)
    await user.click(row)

    // Give any accidental async work a turn to run, then assert nothing fired: neither the
    // dry run itself, nor (the actual regression) a cancel of the real running job.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dryRunMock).not.toHaveBeenCalled()
    expect(cancelMock).not.toHaveBeenCalled()
  })

  it('leaves Dry run (compare)… enabled when nothing is in flight', async () => {
    const dryRunMock = vi.fn().mockResolvedValue(null)
    window.argus.distill.dryRun = dryRunMock
    const user = userEvent.setup()
    renderAnchor({ status: 'open' })
    await user.click(screen.getByRole('button', { name: 'Case actions · NN-5187' }))
    const row = screen.getByText('Dry run (compare)…').closest('button')!
    expect(row.hasAttribute('disabled')).toBe(false)
  })
})

describe('archive actions', () => {
  it('offers Archive on a live case and Restore on an archived one', async () => {
    const user = userEvent.setup()
    renderAnchor({ archivedAt: null })
    await openMenu(user)
    expect(screen.getByText(/archive case/i)).toBeTruthy()
    expect(screen.queryByText(/restore from archive/i)).toBeNull()

    cleanup()
    renderAnchor({ archivedAt: '2026-08-28T00:00:00Z' })
    await openMenu(user)
    expect(screen.getByText(/restore from archive/i)).toBeTruthy()
    expect(screen.queryByText(/archive case/i)).toBeNull()
  })

  it('archives only after the operator confirms', async () => {
    const user = userEvent.setup()
    renderAnchor({ archivedAt: null })
    await openMenu(user)
    // Leaf row inside the open menu — fireEvent, per the hover-menu convention above.
    fireEvent.click(screen.getByText('Archive case…'))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(archiveMock).not.toHaveBeenCalled()

    // Selecting a row closed the menu; reopen it for the second run.
    await openMenu(user)
    fireEvent.click(screen.getByText('Archive case…'))
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }))
    await vi.waitFor(() => expect(archiveMock).toHaveBeenCalledWith('NN-5187'))
  })

  it('surfaces the live-work refusal as the sentence the main process wrote', async () => {
    archiveMock.mockRejectedValue(
      new Error('Case NN-5187 has an agent session still running. Stop it before archiving.')
    )
    const user = userEvent.setup()
    renderAnchor({ archivedAt: null })
    await openMenu(user)
    fireEvent.click(screen.getByText('Archive case…'))
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }))
    await vi.waitFor(() => expect(noticeStore.get().notices).toHaveLength(1))
    expect(noticeStore.get().notices[0].message).toBe(
      'Case NN-5187 has an agent session still running. Stop it before archiving.'
    )
    expect(noticeStore.get().notices[0].tone).toBe('danger')
  })

  it('surfaces a failed restore rather than swallowing it', async () => {
    restoreMock.mockRejectedValue(new Error('bundle checksum mismatch'))
    const user = userEvent.setup()
    renderAnchor({ archivedAt: '2026-08-28T00:00:00Z' })
    await openMenu(user)
    fireEvent.click(screen.getByText('Restore from archive'))
    await vi.waitFor(() => expect(noticeStore.get().notices).toHaveLength(1))
    expect(noticeStore.get().notices[0].message).toBe('bundle checksum mismatch')
    expect(noticeStore.get().notices[0].tone).toBe('danger')
  })

  it('deletes everything when the operator picks the danger button', async () => {
    const user = userEvent.setup()
    renderAnchor({ archivedAt: '2026-08-28T00:00:00Z' })
    await openMenu(user)
    fireEvent.click(screen.getByText(/delete case/i))
    fireEvent.click(await screen.findByRole('button', { name: /delete everything/i }))
    await vi.waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith('NN-5187', { deleteArchive: true })
    )
  })

  it('keeps the archive when the operator picks the alt button', async () => {
    const user = userEvent.setup()
    renderAnchor({ archivedAt: '2026-08-28T00:00:00Z' })
    await openMenu(user)
    fireEvent.click(screen.getByText(/delete case/i))
    fireEvent.click(await screen.findByRole('button', { name: /keep the archive/i }))
    await vi.waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith('NN-5187', { deleteArchive: false })
    )
  })

  it('offers no archive choice at all on a case that was never archived', async () => {
    const user = userEvent.setup()
    renderAnchor({ archivedAt: null })
    await openMenu(user)
    fireEvent.click(screen.getByText(/delete case/i))
    expect(screen.queryByRole('button', { name: /keep the archive/i })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }))
    await vi.waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith('NN-5187', { deleteArchive: false })
    )
  })

  it('leaves the case alone when the delete prompt is cancelled', async () => {
    const user = userEvent.setup()
    const onHome = vi.fn()
    uiStore.openTab('NN-5187')
    renderAnchor({ archivedAt: '2026-08-28T00:00:00Z', onHome })
    await openMenu(user)
    fireEvent.click(screen.getByText(/delete case/i))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(deleteMock).not.toHaveBeenCalled()
    expect(onHome).not.toHaveBeenCalled()
    expect(uiStore.get().recentTabs).toEqual(['NN-5187'])
  })

  it('surfaces a refused delete instead of navigating home as if it worked', async () => {
    deleteMock.mockRejectedValue(new Error('Case NN-5187 is being archived.'))
    const user = userEvent.setup()
    const onHome = vi.fn()
    uiStore.openTab('NN-5187')
    renderAnchor({ archivedAt: null, onHome })
    await openMenu(user)
    fireEvent.click(screen.getByText(/delete case/i))
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }))
    await vi.waitFor(() => expect(noticeStore.get().notices).toHaveLength(1))
    expect(noticeStore.get().notices[0].message).toBe('Case NN-5187 is being archived.')
    expect(onHome).not.toHaveBeenCalled()
    expect(uiStore.get().recentTabs).toEqual(['NN-5187'])
  })
})
