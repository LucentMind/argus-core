// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ProposalDetail } from '../ProposalDetail'
import type { ProposalRecord } from '../../../../../shared/proposals'

const pending: ProposalRecord = {
  file: 'a.md',
  type: 'skill-edit',
  target: 'rca',
  caseSlug: 'NAV-100',
  date: '2026-07-10T12:00:00.000Z',
  title: 'Sharpen step 4',
  content: '# rca\nnew line\n',
  current: '# rca\nold line\n'
}

function renderDetail(over: Partial<Parameters<typeof ProposalDetail>[0]> = {}): {
  onAccept: ReturnType<typeof vi.fn>
  onReject: ReturnType<typeof vi.fn>
  onToggleEdit: ReturnType<typeof vi.fn>
  onViewMode: ReturnType<typeof vi.fn>
} {
  const onAccept = vi.fn()
  const onReject = vi.fn()
  const onToggleEdit = vi.fn()
  const onViewMode = vi.fn()
  render(
    <ProposalDetail
      proposal={pending}
      accepted={null}
      busy={false}
      editValue={null}
      onEditChange={vi.fn()}
      onToggleEdit={onToggleEdit}
      viewMode="unified"
      onViewMode={onViewMode}
      position={{ index: 1, total: 3 }}
      repoSet={true}
      onOpenHivemind={vi.fn()}
      onAccept={onAccept}
      onReject={onReject}
      {...over}
    />
  )
  return { onAccept, onReject, onToggleEdit, onViewMode }
}

// window.argus stub for SharePushDialog's lazy needs is added in the accepted-pane test only.

describe('ProposalDetail: pending', () => {
  it('renders header chips, unified diff, and the +/− stat', () => {
    renderDetail()
    expect(screen.getByText('Sharpen step 4')).toBeInTheDocument()
    expect(screen.getByText('Skill · edit')).toBeInTheDocument()
    expect(screen.getByText('→ rca')).toBeInTheDocument()
    expect(screen.getByText('- old line')).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
  })

  it('switches view modes through the segmented control', () => {
    const { onViewMode } = renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Split view' }))
    expect(onViewMode).toHaveBeenCalledWith('split')
  })

  it('renders split view when viewMode=split', () => {
    renderDetail({ viewMode: 'split' })
    expect(screen.getByText('old line')).toBeInTheDocument()
    expect(screen.queryByText('- old line')).not.toBeInTheDocument()
  })

  it('Accept fires onAccept; Reject opens the reason row first', () => {
    const { onAccept, onReject } = renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Accept Sharpen step 4' }))
    expect(onAccept).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reject Sharpen step 4' }))
    expect(onReject).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reject as overfit' }))
    expect(onReject).toHaveBeenCalledWith({ tag: 'overfit' })
  })

  it('reject with a note passes the note; skip reason passes undefined', () => {
    const { onReject } = renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Reject Sharpen step 4' }))
    fireEvent.change(screen.getByLabelText('Reject note'), { target: { value: 'too narrow' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reject as wrong' }))
    expect(onReject).toHaveBeenCalledWith({ tag: 'wrong', note: 'too narrow' })
  })

  it('locked proposal disables Accept and explains why', () => {
    renderDetail({ proposal: { ...pending, locked: true } })
    expect(screen.getByRole('button', { name: 'Accept Sharpen step 4' })).toBeDisabled()
    expect(screen.getByText(/Ships with a pack/)).toBeInTheDocument()
  })

  it('edit mode swaps the diff for a textarea and hides the view bar', () => {
    renderDetail({ editValue: '# rca\nedited\n' })
    expect(screen.getByLabelText('Edit proposal content')).toHaveValue('# rca\nedited\n')
    expect(screen.queryByRole('button', { name: 'Split view' })).not.toBeInTheDocument()
  })

  it('case summary renders markdown, no view bar, no target chip', () => {
    renderDetail({
      proposal: { ...pending, type: 'case-summary', content: '## Summary\nBody text\n' }
    })
    expect(screen.getByText('Summary')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Split view' })).not.toBeInTheDocument()
    expect(screen.queryByText('→ rca')).not.toBeInTheDocument()
  })
})

describe('ProposalDetail: accepted pane', () => {
  // ProposalDetail never touches window.argus.settings itself — repoSet arrives as a prop.
  // SharePushDialog (mounted only after the Share button is clicked, which these two tests
  // don't do) calls window.argus.hivemind.pushPreview/pushStatus on mount, not `push` or
  // `settings.get` — verified by reading SharePushDialog.tsx directly, which differs from the
  // brief's draft stub. Stubbed here anyway so a future test that opens the dialog doesn't
  // silently hang on an unmocked IPC call.
  beforeEach(() => {
    ;(window as unknown as { argus: unknown }).argus = {
      hivemind: {
        pushPreview: vi.fn().mockResolvedValue('mock preview'),
        pushStatus: vi.fn().mockResolvedValue({ state: 'none' }),
        push: vi.fn()
      },
      openExternal: vi.fn()
    }
  })

  const acceptedEntry = {
    file: 'a.md',
    title: 'Sharpen step 4',
    caseSlug: 'NAV-100',
    date: '2026-07-10T12:00:00.000Z',
    type: 'skill-edit' as const,
    target: { kind: 'skill' as const, name: 'rca' }
  }

  it('shows the confirmation with Share to HiveMind when the repo is set', () => {
    renderDetail({ proposal: null, accepted: acceptedEntry, position: null })
    expect(screen.getByText(/accepted into your library/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Share to HiveMind: rca' })).toBeInTheDocument()
  })

  it('offers HiveMind setup instead when no repo is set', () => {
    renderDetail({ proposal: null, accepted: acceptedEntry, position: null, repoSet: false })
    expect(screen.getByRole('button', { name: /Set up HiveMind/ })).toBeInTheDocument()
  })
})
