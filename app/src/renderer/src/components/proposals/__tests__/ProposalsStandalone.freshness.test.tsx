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
// caseSlug sorts BEFORE recA's NAV-100 (byCase is caseSlug-asc) — a background refetch that
// lands this proposal makes it entries[0], which is exactly the case the pin-the-fallback fix
// (see ProposalsStandalone's entries[0] effect) has to survive: recA must stay selected because
// the user has it open, not because of where it happens to sort.
const recB: ProposalRecord = {
  file: '2026-07-09-NAV-050-lesson.md',
  type: 'recipe',
  target: 'dlt-timing',
  caseSlug: 'NAV-050',
  date: '2026-07-09T12:00:00.000Z',
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

  it('a background refetch preserves an in-flight edit draft, even when the new row sorts first', async () => {
    renderShell()
    await screen.findByRole('button', { name: 'Select proposal Sharpen step 4' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sharpen step 4' }))
    fireEvent.change(screen.getByLabelText('Edit proposal content'), {
      target: { value: 'my half-written draft' }
    })

    // recB (NAV-050) sorts BEFORE recA (NAV-100) — without the fallback pin, entries[0] would
    // flip to recB and silently remount the detail pane on a proposal the user never selected.
    setList({ proposals: [recA, recB] })
    broadcast({ pendingCount: 2, byType: { 'skill-edit': 1, recipe: 1 } })

    await screen.findByRole('button', { name: 'Select proposal Distilled lesson' })
    // The detail pane must still be the ORIGINAL proposal — title and in-flight draft both —
    // not silently retargeted to whichever proposal now sorts first.
    expect(screen.getByRole('heading', { name: 'Sharpen step 4' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Accept Sharpen step 4' })).toBeInTheDocument()
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

  it('a same-day re-distill regenerating the accepted filename replaces the accepted row with the fresh pending one', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Realistic accept mock: returns the remaining pending list with the accepted file
    // filtered out, the same IPC contract exercised in ProposalsStandalone.test.tsx.
    ;(
      window as unknown as { argus: { proposals: { accept: ReturnType<typeof vi.fn> } } }
    ).argus.proposals.accept = vi.fn((file: string) =>
      Promise.resolve({
        proposals: [recA].filter((p) => p.file !== file),
        accepted: { kind: 'skill', name: 'rca' }
      })
    )
    renderShell()
    fireEvent.click(await screen.findByRole('button', { name: 'Accept Sharpen step 4' }))
    await screen.findByText(/accepted into your library/i)

    // writeProposal only uniquifies the filename against files still present — with the
    // original archived out of the way by accept, a same-day re-distill regenerates the
    // IDENTICAL filename. The re-proposed record is otherwise a fresh proposal (new title).
    const reproposed: ProposalRecord = { ...recA, title: 'Sharpen step 4 (re-distilled)' }
    setList({ proposals: [reproposed] })
    broadcast({ pendingCount: 1, byType: { 'skill-edit': 1 } })

    // Exactly ONE queue row for this file — the accepted entry must not shadow the fresh
    // pending one (that would leave the re-proposed proposal unactionable).
    expect(
      await screen.findByRole('button', { name: 'Select proposal Sharpen step 4 (re-distilled)' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Select proposal Sharpen step 4' })
    ).not.toBeInTheDocument()

    // The detail pane shows the PENDING record — Accept enabled — not the accepted pane.
    expect(screen.queryByText(/accepted into your library/i)).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Accept Sharpen step 4 (re-distilled)' })
    ).not.toBeDisabled()

    // No React duplicate-key warning from handing ProposalQueue two entries keyed by the
    // same `file`.
    expect(errorSpy.mock.calls.some((args) => String(args[0]).includes('same key'))).toBe(false)
    errorSpy.mockRestore()
  })
})
