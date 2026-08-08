// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ProposalsStandalone } from '../ProposalsStandalone'
import { settingsStore } from '../../../lib/settingsStore'
import { proposalsStore } from '../../../lib/proposalsStore'
import type { ProposalsPayload } from '../../../../../shared/proposals'

const payload: ProposalsPayload = {
  proposals: [
    {
      file: '2026-07-10-NAV-100-rca.md',
      type: 'skill-edit',
      target: 'rca',
      caseSlug: 'NAV-100',
      date: '2026-07-10T12:00:00.000Z',
      title: 'Sharpen step 4',
      content: '# rca\nnew line\n',
      current: '# rca\nold line\n'
    },
    {
      file: '2026-07-11-NAV-100-skill.md',
      type: 'skill-new',
      target: 'new-skill',
      caseSlug: 'NAV-100',
      date: '2026-07-11T12:00:00.000Z',
      title: 'New skill proposal',
      content: '# new skill\n',
      current: null
    },
    {
      file: '2026-07-12-NAV-100-ref.md',
      type: 'reference-edit',
      target: 'ref-doc',
      caseSlug: 'NAV-100',
      date: '2026-07-12T12:00:00.000Z',
      title: 'Reference edit proposal',
      content: '# ref\nnew\n',
      current: '# ref\nold\n'
    },
    {
      file: '2026-07-13-NAV-100-locked.md',
      type: 'skill-edit',
      target: 'locked-skill',
      caseSlug: 'NAV-100',
      date: '2026-07-13T12:00:00.000Z',
      title: 'Locked proposal',
      content: '# locked\nnew\n',
      current: '# locked\nold\n',
      locked: true
    }
  ]
}

let acceptMock: ReturnType<typeof vi.fn>
let rejectMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  settingsStore.reset()
  proposalsStore.reset()
  acceptMock = vi
    .fn()
    .mockResolvedValue({ proposals: [], accepted: { kind: 'skill', name: 'rca' } })
  rejectMock = vi.fn().mockResolvedValue({ proposals: [] })
  ;(window as unknown as { argus: unknown }).argus = {
    proposals: {
      list: vi.fn().mockResolvedValue(payload),
      accept: acceptMock,
      reject: rejectMock,
      onChanged: vi.fn(() => () => {})
    },
    settings: {
      get: vi.fn(async () => ({
        settings: { hivemind: { repo: 'org/hive' }, ui: { knowledgeStripDismissed: true } },
        loadError: null
      })),
      onChanged: vi.fn(() => () => {})
    }
  }
})

function renderShell(over: Partial<Parameters<typeof ProposalsStandalone>[0]> = {}): void {
  render(<ProposalsStandalone onClose={vi.fn()} onNavigateSettings={vi.fn()} {...over} />)
}

describe('ProposalsStandalone', () => {
  it('selects the first proposal by default and shows its diff in the detail pane', async () => {
    renderShell()
    expect(await screen.findByText('- old line')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select proposal Sharpen step 4' })).toHaveAttribute(
      'aria-current',
      'true'
    )
  })

  it('clicking another queue row swaps the detail pane', async () => {
    renderShell()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Select proposal New skill proposal' })
    )
    expect(screen.getByRole('button', { name: 'Accept New skill proposal' })).toBeInTheDocument()
  })

  it('initialTypes preset seeds the filter and hides other rows', async () => {
    renderShell({ initialTypes: ['reference-edit'] })
    expect(
      await screen.findByRole('button', { name: 'Select proposal Reference edit proposal' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Select proposal Sharpen step 4' })
    ).not.toBeInTheDocument()
  })

  it('accept keeps selection on the row, flips it to accepted, offers Share', async () => {
    renderShell()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept Sharpen step 4' }))
    expect(acceptMock).toHaveBeenCalledWith('2026-07-10-NAV-100-rca.md')
    expect(await screen.findByText(/accepted into your library/)).toBeInTheDocument()
    // queue row remains, now in accepted style
    expect(screen.getByRole('button', { name: 'Select proposal Sharpen step 4' })).toHaveAttribute(
      'aria-current',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Share to HiveMind: rca' })).toBeInTheDocument()
  })

  it('accept while editing sends the edited content', async () => {
    renderShell()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Sharpen step 4' }))
    fireEvent.change(screen.getByLabelText('Edit proposal content'), {
      target: { value: '# rca\nedited\n' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Accept Sharpen step 4' }))
    expect(acceptMock).toHaveBeenCalledWith(expect.any(String), '# rca\nedited\n')
  })

  it('reject advances selection to the next pending row', async () => {
    renderShell()
    fireEvent.click(await screen.findByRole('button', { name: 'Reject Sharpen step 4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reject without a reason' }))
    await waitFor(() => expect(rejectMock).toHaveBeenCalled())
    expect(
      screen.getByRole('button', { name: 'Select proposal New skill proposal' })
    ).toHaveAttribute('aria-current', 'true')
  })

  it('empty payload shows the empty-state copy', async () => {
    ;(
      window as unknown as { argus: { proposals: { list: ReturnType<typeof vi.fn> } } }
    ).argus.proposals.list = vi.fn().mockResolvedValue({ proposals: [] })
    renderShell()
    expect(await screen.findByText(/No pending proposals/)).toBeInTheDocument()
  })

  it('renders the knowledge flow strip when not dismissed, and Library navigates to settings', async () => {
    ;(
      window as unknown as { argus: { settings: { get: ReturnType<typeof vi.fn> } } }
    ).argus.settings.get = vi.fn(async () => ({
      settings: { hivemind: { repo: 'org/hive' }, ui: { knowledgeStripDismissed: false } },
      loadError: null
    }))
    const onNavigateSettings = vi.fn()
    renderShell({ onNavigateSettings })
    // strip's own aria: nav "Knowledge flow" with a Library step button
    const strip = await screen.findByRole('navigation', { name: 'Knowledge flow' })
    fireEvent.click(within(strip).getByRole('button', { name: /Library/ }))
    expect(onNavigateSettings).toHaveBeenCalledWith('library')
  })
})
