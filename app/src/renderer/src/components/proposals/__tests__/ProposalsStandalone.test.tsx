// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ProposalsStandalone } from '../ProposalsStandalone'
import { settingsStore } from '../../../lib/settingsStore'
import { proposalsStore } from '../../../lib/proposalsStore'
import { viewTitleStore } from '../../../lib/viewTitleStore'
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
  viewTitleStore.reset()
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
      rejectDigest: vi.fn().mockResolvedValue(null),
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

  // The view has no title row of its own any more (user-directed, 2026-08-08) — TopBar renders
  // it, from this store, and the pending count rides along as the detail. Asserted here rather
  // than through a rendered node precisely because the node is a SIBLING view's; the store is
  // the whole contract between them.
  it('publishes its title and live pending count for the header, and clears it on unmount', async () => {
    const { unmount } = render(
      <ProposalsStandalone onClose={vi.fn()} onNavigateSettings={vi.fn()} />
    )
    await waitFor(() => expect(viewTitleStore.get()?.label).toBe('Proposals'))
    expect(viewTitleStore.get()?.detail).toBe('· 4 pending')
    // Accepting one drops the count — the header is not a snapshot of the moment it opened.
    fireEvent.click(await screen.findByRole('button', { name: 'Select proposal Sharpen step 4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Accept Sharpen step 4' }))
    await waitFor(() => expect(viewTitleStore.get()?.detail).toBe('· 3 pending'))
    unmount()
    expect(viewTitleStore.get()).toBeNull()
  })

  // A count of 0 while the list is still in flight would be a claim, not a placeholder.
  it('publishes no count until the list has loaded', () => {
    render(<ProposalsStandalone onClose={vi.fn()} onNavigateSettings={vi.fn()} />)
    expect(viewTitleStore.get()).toEqual({ label: 'Proposals', detail: undefined })
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
    expect(acceptMock).toHaveBeenCalledWith('2026-07-10-NAV-100-rca.md', undefined, undefined)
    expect(await screen.findByText(/accepted into your library/)).toBeInTheDocument()
    // queue row remains, now in accepted style
    expect(screen.getByRole('button', { name: 'Select proposal Sharpen step 4' })).toHaveAttribute(
      'aria-current',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Share to HiveMind: rca' })).toBeInTheDocument()
  })

  // A distill run stages its proposals in a synchronous loop, so several land on the identical
  // ISO-millisecond `date` — which the caseSlug+date comparator can't separate. Accepting used to
  // throw the row to the bottom of that tie group (pending rows all precede accepted ones in the
  // pre-sort array, and a stable sort keeps that order for equal keys). The row must not move.
  it('accepting a row whose date ties with its neighbours leaves it in the same queue position', async () => {
    const stamp = '2026-07-14T09:00:00.000Z'
    const tied: ProposalsPayload = {
      proposals: ['a', 'b', 'c'].map((n) => ({
        file: `2026-07-14-NAV-200-${n}.md`,
        type: 'reference-edit' as const,
        target: `topic-${n}`,
        caseSlug: 'NAV-200',
        date: stamp,
        title: `Tied ${n}`,
        content: `# ${n}\nnew\n`,
        current: `# ${n}\nold\n`
      }))
    }
    ;(window as unknown as { argus: { proposals: Record<string, unknown> } }).argus.proposals = {
      list: vi.fn().mockResolvedValue(tied),
      accept: vi.fn((file: string) =>
        Promise.resolve({
          proposals: tied.proposals.filter((p) => p.file !== file),
          accepted: { kind: 'reference', name: 'topic-b' }
        })
      ),
      reject: vi.fn(),
      rejectDigest: vi.fn().mockResolvedValue(null),
      onChanged: vi.fn(() => () => {})
    }
    const order = (): string[] =>
      screen
        .getAllByRole('button', { name: /^Select proposal / })
        .map((b) => b.getAttribute('aria-label')!)
    renderShell()
    await screen.findByRole('button', { name: 'Select proposal Tied a' })
    const before = order()
    fireEvent.click(screen.getByRole('button', { name: 'Select proposal Tied b' }))
    fireEvent.click(screen.getByRole('button', { name: 'Accept Tied b' }))
    expect(await screen.findByText(/accepted into your library/)).toBeInTheDocument()
    expect(order()).toEqual(before)
  })

  it('accept while editing sends the edited content', async () => {
    renderShell()
    fireEvent.click(await screen.findByRole('button', { name: 'Select proposal Sharpen step 4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sharpen step 4' }))
    fireEvent.change(screen.getByLabelText('Edit proposal content'), {
      target: { value: '# rca\nedited\n' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Accept Sharpen step 4' }))
    expect(acceptMock).toHaveBeenCalledWith(expect.any(String), '# rca\nedited\n', undefined)
  })

  // Regression for the data-loss bug: `editing[file][path]` used to encode BOTH "is this pane
  // in edit mode" and the draft text, and toggling out of edit mode (`Edit` -> `View diff`)
  // deleted the map entry outright. Reviewing an edit before accepting — the exact gesture the
  // "View diff" button invites — silently threw the edit away.
  it('an edit survives toggling to View diff and back to Edit', async () => {
    renderShell()
    fireEvent.click(await screen.findByRole('button', { name: 'Select proposal Sharpen step 4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sharpen step 4' }))
    fireEvent.change(screen.getByLabelText('Edit proposal content'), {
      target: { value: '# rca\nedited\n' }
    })
    // Same aria-label at every mode — only the visible text toggles.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sharpen step 4' })) // -> View diff
    expect(screen.queryByLabelText('Edit proposal content')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sharpen step 4' })) // -> back to Edit
    expect(screen.getByLabelText('Edit proposal content')).toHaveValue('# rca\nedited\n')
  })

  // The severe half of the same bug: acceptSelected reads the very map that toggling used to
  // clear, so Edit -> View diff -> Accept used to silently accept the ORIGINAL, unedited
  // proposal with nothing on screen contradicting the user. This is the data-loss guard.
  it('accept sends the edited content after a round trip through the diff view', async () => {
    renderShell()
    fireEvent.click(await screen.findByRole('button', { name: 'Select proposal Sharpen step 4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sharpen step 4' }))
    fireEvent.change(screen.getByLabelText('Edit proposal content'), {
      target: { value: '# rca\nedited\n' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sharpen step 4' })) // -> View diff
    fireEvent.click(screen.getByRole('button', { name: 'Accept Sharpen step 4' }))
    expect(acceptMock).toHaveBeenCalledWith(expect.any(String), '# rca\nedited\n', undefined)
  })

  // Requirement 2: the diff shown after toggling off Edit must reflect what the user typed, not
  // the agent's original proposal — that's the entire point of "review before you accept".
  it('the diff view after toggling off Edit shows the edited text, not the original proposal', async () => {
    renderShell()
    fireEvent.click(await screen.findByRole('button', { name: 'Select proposal Sharpen step 4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sharpen step 4' }))
    fireEvent.change(screen.getByLabelText('Edit proposal content'), {
      target: { value: '# rca\nedited\n' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sharpen step 4' })) // -> View diff
    expect(screen.getByText('+ edited')).toBeInTheDocument()
    expect(screen.queryByText('+ new line')).not.toBeInTheDocument()
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

  // Regression for the "next = null" advance branch: rejecting the only pending row leaves
  // pendingSorted empty, so rejectSelected's `next` computation falls all the way through to
  // null — unexercised before this test (see the review's carried-forward minor finding).
  it('rejecting the only pending row falls back to the empty state without crashing', async () => {
    const solo: ProposalsPayload = { proposals: [payload.proposals[0]] }
    const list = vi.fn().mockResolvedValue(solo)
    // Genuinely empty, not a stale echo of `solo` — the real IPC contract after the only row
    // is gone.
    const reject = vi.fn().mockResolvedValue({ proposals: [] })
    const argus = (
      window as unknown as {
        argus: { proposals: { list: ReturnType<typeof vi.fn>; reject: ReturnType<typeof vi.fn> } }
      }
    ).argus
    argus.proposals.list = list
    argus.proposals.reject = reject
    renderShell()
    fireEvent.click(await screen.findByRole('button', { name: 'Reject Sharpen step 4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reject without a reason' }))
    await waitFor(() => expect(reject).toHaveBeenCalledWith('2026-07-10-NAV-100-rca.md', undefined))
    expect(await screen.findByText(/No pending proposals/)).toBeInTheDocument()
  })

  // Same "next = null" branch, but with a session-accepted row still around: the entries[0]
  // fallback (the pin fix under test elsewhere in this suite) must land selection on it instead
  // of leaving the view looking blank.
  it('rejecting the last pending row falls back to a session-accepted row via the entries[0] fallback', async () => {
    const two: ProposalsPayload = { proposals: [payload.proposals[0], payload.proposals[2]] }
    const list = vi.fn().mockResolvedValue(two)
    const accept = vi.fn((file: string) =>
      Promise.resolve({
        proposals: two.proposals.filter((p) => p.file !== file),
        accepted: { kind: 'skill', name: 'rca' }
      })
    )
    const reject = vi.fn().mockResolvedValue({ proposals: [] })
    const argus = (
      window as unknown as {
        argus: {
          proposals: {
            list: ReturnType<typeof vi.fn>
            accept: ReturnType<typeof vi.fn>
            reject: ReturnType<typeof vi.fn>
          }
        }
      }
    ).argus
    argus.proposals.list = list
    argus.proposals.accept = accept
    argus.proposals.reject = reject
    renderShell()

    fireEvent.click(await screen.findByRole('button', { name: 'Select proposal Sharpen step 4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Accept Sharpen step 4' }))
    await screen.findByText(/accepted into your library/i)

    fireEvent.click(
      await screen.findByRole('button', { name: 'Select proposal Reference edit proposal' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reject Reference edit proposal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reject without a reason' }))
    await waitFor(() => expect(reject).toHaveBeenCalled())

    // No pending rows left — entries[0] is the session-accepted row, and the fallback commits
    // it as the selection instead of leaving `selectedFile` null forever.
    expect(await screen.findByText(/accepted into your library/i)).toBeInTheDocument()
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
    // One chip per icon family now — "Skill" covers skill-edit and skill-new together.
    const chip = await screen.findByRole('button', { name: 'Filter Skill' })
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
        rejectDigest: vi.fn().mockResolvedValue(null),
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

describe('per-file edits', () => {
  const withFiles: ProposalsPayload = {
    proposals: [
      {
        file: '2026-08-19-ACME-1-collect-logs',
        type: 'skill-new',
        target: 'collect-logs',
        caseSlug: 'ACME-1',
        date: '2026-08-19T12:00:00.000Z',
        title: 'Collect logs',
        content: '---\ndescription: d\n---\n# Collect logs\n',
        current: null,
        files: [
          {
            path: 'scripts/collect.sh',
            content: '#!/bin/sh\necho hi\n',
            current: null,
            exec: true
          }
        ]
      }
    ]
  }

  // Runs after the file's outer beforeEach, which installed the full `window.argus`; this
  // replaces only the proposals slice so the settings stub (hivemind repo) stays intact.
  beforeEach(() => {
    acceptMock = vi.fn(() =>
      Promise.resolve({ proposals: [], accepted: { kind: 'skill', name: 'collect-logs' } })
    )
    ;(window as unknown as { argus: { proposals: unknown } }).argus.proposals = {
      list: vi.fn().mockResolvedValue(withFiles),
      accept: acceptMock,
      reject: rejectMock,
      rejectDigest: vi.fn().mockResolvedValue(null),
      onChanged: vi.fn(() => () => {})
    }
  })

  it('sends a sibling edit as editedFiles and leaves editedContent undefined', async () => {
    renderShell()
    await screen.findByRole('tablist', { name: 'Files in this proposal' })
    fireEvent.click(screen.getByRole('tab', { name: /collect\.sh/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Collect logs' }))
    fireEvent.change(screen.getByLabelText('Edit proposal content'), {
      target: { value: '#!/bin/sh\necho edited\n' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Accept Collect logs' }))

    await waitFor(() =>
      expect(acceptMock).toHaveBeenCalledWith('2026-08-19-ACME-1-collect-logs', undefined, {
        'scripts/collect.sh': '#!/bin/sh\necho edited\n'
      })
    )
  })

  it('sends a body edit as editedContent, with no editedFiles', async () => {
    renderShell()
    await screen.findByRole('tablist', { name: 'Files in this proposal' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Collect logs' }))
    fireEvent.change(screen.getByLabelText('Edit proposal content'), {
      target: { value: 'edited body\n' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Accept Collect logs' }))

    await waitFor(() =>
      expect(acceptMock).toHaveBeenCalledWith(
        '2026-08-19-ACME-1-collect-logs',
        'edited body\n',
        undefined
      )
    )
  })

  it('keeps a body edit and a sibling edit in separate buffers', async () => {
    renderShell()
    await screen.findByRole('tablist', { name: 'Files in this proposal' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Collect logs' }))
    fireEvent.change(screen.getByLabelText('Edit proposal content'), {
      target: { value: 'edited body\n' }
    })
    // Switching files must not carry the body's draft into the sibling's buffer.
    fireEvent.click(screen.getByRole('tab', { name: /collect\.sh/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Collect logs' }))
    expect(screen.getByLabelText('Edit proposal content')).toHaveValue('#!/bin/sh\necho hi\n')
  })

  // A reviewer who accepts a proposal carrying a script and then glances back at the queue
  // must still see the exec signal — the row stays visible for the rest of the session
  // (acceptedVisible), so `hasExec` has to survive the accept, not just precede it.
  it('keeps the exec chip on the queue row after the proposal is accepted', async () => {
    renderShell()
    await screen.findByRole('tablist', { name: 'Files in this proposal' })
    expect(screen.getByRole('button', { name: 'Select proposal Collect logs' })).toHaveTextContent(
      'exec'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Accept Collect logs' }))
    await waitFor(() => expect(acceptMock).toHaveBeenCalled())
    expect(
      await screen.findByRole('button', { name: 'Select proposal Collect logs' })
    ).toHaveTextContent('exec')
  })
})
