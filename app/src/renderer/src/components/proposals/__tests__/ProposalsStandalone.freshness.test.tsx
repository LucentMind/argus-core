// @vitest-environment jsdom
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ProposalsStandalone } from '../ProposalsStandalone'
import { settingsStore } from '../../../lib/settingsStore'
import { proposalsStore } from '../../../lib/proposalsStore'
import type {
  ProposalCounts,
  ProposalRecord,
  ProposalsPayload
} from '../../../../../shared/proposals'

// Ported from the old ProposalsPage.freshness.test.tsx, re-targeted at
// ProposalsStandalone — same store-driven mechanism: proposalsStore.start()
// registers a single window.argus.proposals.onChanged subscriber, and the
// standalone view's own fetch effect depends on useProposalCounts(), so a
// broadcast that changes counts re-triggers its list() call.

const recA: ProposalRecord = {
  file: '2026-07-10-NAV-100-rca.md',
  type: 'skill-edit',
  target: 'rca',
  caseSlug: 'NAV-100',
  date: '2026-07-10T12:00:00.000Z',
  title: 'Sharpen step 4',
  content: '# rca\nnew line\n',
  current: '# rca\nold line\n'
}
const recB: ProposalRecord = {
  file: '2026-07-11-NAV-200-lesson.md',
  type: 'recipe',
  target: 'dlt-timing',
  caseSlug: 'NAV-200',
  date: '2026-07-11T12:00:00.000Z',
  title: 'Distilled lesson',
  content: 'fact body',
  current: null
}

let list: ReturnType<typeof vi.fn>
let fireChanged: ((c: ProposalCounts) => void) | null

function setList(p: ProposalsPayload): void {
  list.mockResolvedValue(p)
}

beforeEach(() => {
  settingsStore.reset()
  proposalsStore.reset()
  fireChanged = null
  list = vi.fn().mockResolvedValue({ proposals: [recA] })
  ;(window as unknown as { argus: unknown }).argus = {
    proposals: {
      list,
      accept: vi
        .fn()
        .mockResolvedValue({ proposals: [], accepted: { kind: 'skill', name: 'rca' } }),
      reject: vi.fn().mockResolvedValue({ proposals: [] }),
      onChanged: vi.fn((cb: (c: ProposalCounts) => void) => {
        fireChanged = cb
        return () => {}
      })
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

function renderShell(): void {
  render(<ProposalsStandalone onClose={vi.fn()} onNavigateSettings={vi.fn()} />)
}

function broadcast(c: ProposalCounts): void {
  expect(fireChanged).not.toBeNull() // the view must subscribe via the proposals store
  act(() => fireChanged!(c))
}

describe('ProposalsStandalone freshness', () => {
  it('refetches the list when a proposals:changed broadcast arrives', async () => {
    renderShell()
    // The title renders both in the queue row and the detail header — anchor
    // on the (unique) queue row's accessible name.
    await screen.findByRole('button', { name: 'Select proposal Sharpen step 4' })
    expect(
      screen.queryByRole('button', { name: 'Select proposal Distilled lesson' })
    ).not.toBeInTheDocument()

    // distill staging lands a new proposal in the background
    setList({ proposals: [recA, recB] })
    broadcast({ pendingCount: 2, byType: { 'skill-edit': 1, recipe: 1 } })

    expect(
      await screen.findByRole('button', { name: 'Select proposal Distilled lesson' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Select proposal Sharpen step 4' })
    ).toBeInTheDocument()
  })

  it('a background refetch preserves an in-flight edit draft', async () => {
    renderShell()
    await screen.findByRole('button', { name: 'Select proposal Sharpen step 4' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sharpen step 4' }))
    fireEvent.change(screen.getByLabelText('Edit proposal content'), {
      target: { value: 'my half-written draft' }
    })

    setList({ proposals: [recA, recB] })
    broadcast({ pendingCount: 2, byType: { 'skill-edit': 1, recipe: 1 } })

    await screen.findByRole('button', { name: 'Select proposal Distilled lesson' })
    expect(screen.getByLabelText('Edit proposal content')).toHaveValue('my half-written draft')
  })

  it('a background refetch preserves the just-accepted banner', async () => {
    renderShell()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept Sharpen step 4' }))
    await screen.findByText(/accepted into your library/i)

    setList({ proposals: [] })
    broadcast({ pendingCount: 0, byType: {} })

    // "0 pending" renders in both the top bar and the queue header — scope to
    // the queue (an <aside>, implicit role "complementary").
    await waitFor(() =>
      expect(within(screen.getByRole('complementary')).getByText(/0 pending/)).toBeInTheDocument()
    )
    expect(screen.getByText(/accepted into your library/i)).toBeInTheDocument()
  })

  it('a failed background refetch keeps the current list and surfaces the error', async () => {
    renderShell()
    await screen.findByRole('button', { name: 'Select proposal Sharpen step 4' })

    list.mockRejectedValue(new Error('ipc dead'))
    broadcast({ pendingCount: 1, byType: { 'skill-edit': 1 } })

    expect(await screen.findByRole('alert')).toHaveTextContent(/ipc dead/)
    expect(
      screen.getByRole('button', { name: 'Select proposal Sharpen step 4' })
    ).toBeInTheDocument()
  })
})
