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

// Sort order is caseSlug asc, then date DESC (same comparator as the old
// ProposalsPage) — within NAV-100 that's: Locked (07-13), Reference edit
// (07-12), New skill (07-11), Sharpen step 4 (07-10, oldest → last).

let acceptMock: ReturnType<typeof vi.fn>
let rejectMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  settingsStore.reset()
  proposalsStore.reset()
  // Realistic IPC behavior: accept/reject return the fresh remaining list
  // (source of truth may have also changed other rows via a distiller run),
  // never a hardcoded empty array — the component trusts this response
  // verbatim, exactly as the old ProposalsPage's `act()` does.
  acceptMock = vi.fn((file: string) =>
    Promise.resolve({
      proposals: payload.proposals.filter((p) => p.file !== file),
      accepted: { kind: 'skill', name: 'rca' }
    })
  )
  rejectMock = vi.fn((file: string) =>
    Promise.resolve({ proposals: payload.proposals.filter((p) => p.file !== file) })
  )
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
    // First in caseSlug-asc/date-desc order is the newest proposal: Locked proposal (07-13).
    expect(await screen.findByText('- old')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select proposal Locked proposal' })).toHaveAttribute(
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
    fireEvent.click(await screen.findByRole('button', { name: 'Select proposal Sharpen step 4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Accept Sharpen step 4' }))
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
    fireEvent.click(await screen.findByRole('button', { name: 'Select proposal Sharpen step 4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sharpen step 4' }))
    fireEvent.change(screen.getByLabelText('Edit proposal content'), {
      target: { value: '# rca\nedited\n' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Accept Sharpen step 4' }))
    expect(acceptMock).toHaveBeenCalledWith(expect.any(String), '# rca\nedited\n')
  })

  it('reject the last pending row (in display order) advances to the previous one', async () => {
    renderShell()
    // Sharpen step 4 is oldest → last in the caseSlug-asc/date-desc order.
    fireEvent.click(await screen.findByRole('button', { name: 'Select proposal Sharpen step 4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reject Sharpen step 4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reject without a reason' }))
    await waitFor(() =>
      expect(rejectMock).toHaveBeenCalledWith('2026-07-10-NAV-100-rca.md', undefined)
    )
    expect(
      screen.getByRole('button', { name: 'Select proposal New skill proposal' })
    ).toHaveAttribute('aria-current', 'true')
  })

  it('reject a middle pending row advances to the next one', async () => {
    renderShell()
    // New skill proposal sits between Reference edit and Sharpen step 4 in
    // display order — rejecting it should advance forward, not back.
    fireEvent.click(
      await screen.findByRole('button', { name: 'Select proposal New skill proposal' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reject New skill proposal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reject without a reason' }))
    await waitFor(() =>
      expect(rejectMock).toHaveBeenCalledWith('2026-07-11-NAV-100-skill.md', undefined)
    )
    expect(screen.getByRole('button', { name: 'Select proposal Sharpen step 4' })).toHaveAttribute(
      'aria-current',
      'true'
    )
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

  // Ported from the old ProposalsPage.test.tsx — same regression, re-targeted at the
  // standalone view: `active` (the chip-filter state) must not keep a type once its
  // last matching proposal disappears from the list, else the filtered view stays
  // empty though other (non-matching-type) proposals still exist.
  it('accepting the only proposal of an active filter type does not hide the remaining proposals', async () => {
    ;(
      window as unknown as { argus: { proposals: { accept: ReturnType<typeof vi.fn> } } }
    ).argus.proposals.accept = vi.fn().mockResolvedValue({
      proposals: [payload.proposals[2]], // only the reference-edit proposal remains
      accepted: { kind: 'skill', name: 'rca' }
    })
    renderShell()
    const chip = await screen.findByRole('button', { name: 'Filter Skill · edit' })
    fireEvent.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(await screen.findByRole('button', { name: 'Select proposal Sharpen step 4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Accept Sharpen step 4' }))

    expect(await screen.findByText('Reference edit proposal')).toBeInTheDocument()
  })

  // Ported from ProposalsPage.test.tsx's "mount fetch error surfaces in alert banner
  // instead of hanging" — the initial-mount list() rejection, distinct from a failed
  // background refetch (covered in ProposalsStandalone.freshness.test.tsx).
  it('mount fetch error surfaces in alert banner instead of hanging', async () => {
    // the proposals store's own priming shares the rejecting list() and warns too —
    // keep test output clean.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(window as unknown as { argus: unknown }).argus = {
      proposals: {
        list: vi.fn().mockRejectedValue(new Error('ipc dead')),
        accept: vi.fn().mockResolvedValue({ proposals: [] }),
        reject: vi.fn().mockResolvedValue({ proposals: [] }),
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
    renderShell()
    expect(await screen.findByRole('alert')).toHaveTextContent(/ipc dead/)
    expect(await screen.findByText(/No pending proposals/)).toBeInTheDocument()
    warn.mockRestore()
  })

  // Ported from ProposalsPage.test.tsx's "without a hive repo the row links to
  // HiveMind setup instead" — re-targeted at the standalone view's onNavigateSettings
  // callback (ProposalDetail's own unit test only checks the button renders, not the
  // wiring through to navigation).
  it('without a hive repo, Set up HiveMind routes to the team settings page', async () => {
    ;(
      window as unknown as { argus: { settings: { get: ReturnType<typeof vi.fn> } } }
    ).argus.settings.get = vi.fn(async () => ({
      settings: { hivemind: { repo: '' }, ui: { knowledgeStripDismissed: true } },
      loadError: null
    }))
    const onNavigateSettings = vi.fn()
    renderShell({ onNavigateSettings })
    fireEvent.click(await screen.findByRole('button', { name: 'Select proposal Sharpen step 4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Accept Sharpen step 4' }))
    const link = await screen.findByRole('button', { name: 'Set up HiveMind to share →' })
    fireEvent.click(link)
    expect(onNavigateSettings).toHaveBeenCalledWith('team')
  })
})
