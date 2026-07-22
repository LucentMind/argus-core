// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ProposalsPage } from '../ProposalsPage'
import { settingsStore } from '../../../lib/settingsStore'
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
    }
  ]
}

beforeEach(() => {
  settingsStore.reset()
  ;(window as unknown as { argus: unknown }).argus = {
    proposals: {
      list: vi.fn().mockResolvedValue(payload),
      accept: vi
        .fn()
        .mockResolvedValue({ proposals: [], accepted: { kind: 'skill', name: 'my-skill' } }),
      reject: vi.fn().mockResolvedValue({ proposals: [] })
    },
    settings: {
      get: vi.fn(async () => ({ settings: { hivemind: { repo: 'org/hive' } }, loadError: null })),
      onChanged: vi.fn(() => () => {})
    }
  }
})

describe('ProposalsPage', () => {
  it('renders pending proposals with a line diff', async () => {
    render(<ProposalsPage />)
    expect(await screen.findByText('Sharpen step 4')).toBeInTheDocument()
    expect(screen.getByText('- old line')).toBeInTheDocument()
    expect(screen.getByText('+ new line')).toBeInTheDocument()
  })

  it('accept invokes the IPC, refreshes and clears the proposal', async () => {
    render(<ProposalsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Accept Sharpen step 4' }))
    expect(
      (window as unknown as { argus: { proposals: { accept: ReturnType<typeof vi.fn> } } }).argus
        .proposals.accept
    ).toHaveBeenCalledWith('2026-07-10-NAV-100-rca.md')
    expect(await screen.findByText(/No pending proposals/)).toBeInTheDocument()
  })

  it('reject archives without applying', async () => {
    render(<ProposalsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reject Sharpen step 4' }))
    await waitFor(() =>
      expect(
        (window as unknown as { argus: { proposals: { reject: ReturnType<typeof vi.fn> } } }).argus
          .proposals.reject
      ).toHaveBeenCalled()
    )
  })

  it('mount fetch error surfaces in alert banner instead of hanging', async () => {
    ;(window as unknown as { argus: unknown }).argus = {
      proposals: {
        list: vi.fn().mockRejectedValue(new Error('ipc dead')),
        accept: vi.fn().mockResolvedValue({ proposals: [] }),
        reject: vi.fn().mockResolvedValue({ proposals: [] })
      },
      settings: {
        get: vi.fn(async () => ({ settings: { hivemind: { repo: 'org/hive' } }, loadError: null })),
        onChanged: vi.fn(() => () => {})
      }
    }
    render(<ProposalsPage />)
    // Assert loading text is gone and error banner appears
    await waitFor(() => {
      expect(screen.queryByText('loading…')).not.toBeInTheDocument()
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(/ipc dead/)
  })

  it('filters via multi-select type chips', async () => {
    render(<ProposalsPage />)
    const chip = await screen.findByRole('button', { name: 'Filter Skill · new' })
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    // only skill-new proposals remain visible
    expect(screen.queryByText('Reference')).not.toBeInTheDocument()
    fireEvent.click(chip) // toggle off → all visible again
    expect(await screen.findByText('Reference')).toBeInTheDocument()
  })

  it('initialTypes pre-activates chips', async () => {
    render(<ProposalsPage initialTypes={['skill-new']} />)
    const chip = await screen.findByRole('button', { name: 'Filter Skill · new' })
    expect(chip).toHaveAttribute('aria-pressed', 'true')
  })

  it('accepting a skill proposal offers Share to HiveMind', async () => {
    render(<ProposalsPage />)
    const acceptButtons = await screen.findAllByRole('button', { name: /^Accept / })
    fireEvent.click(acceptButtons[0])
    expect(await screen.findByText(/accepted into your library/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Share .* to HiveMind/ })).toBeInTheDocument()
  })

  it('without a hive repo the row links to HiveMind setup instead', async () => {
    ;(
      window as never as { argus: { settings: { get: ReturnType<typeof vi.fn> } } }
    ).argus.settings.get.mockResolvedValue({
      settings: { hivemind: { repo: '' } },
      loadError: null
    })
    const onOpenHivemind = vi.fn()
    render(<ProposalsPage onOpenHivemind={onOpenHivemind} />)
    const acceptButtons = await screen.findAllByRole('button', { name: /^Accept / })
    fireEvent.click(acceptButtons[0])
    const link = await screen.findByRole('button', { name: 'Set up HiveMind to share →' })
    fireEvent.click(link)
    expect(onOpenHivemind).toHaveBeenCalledTimes(1)
  })
})
