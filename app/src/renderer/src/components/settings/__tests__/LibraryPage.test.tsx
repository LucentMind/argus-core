// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { LibraryPage } from '../LibraryPage'
import { confirm } from '../../../lib/confirmStore'
import { referenceSyncStore } from '../../../lib/referenceSyncStore'
import type { SkillsPayload } from '../../../../../shared/memoryIpc'
import type { RefSyncPayload } from '../../../../../shared/referenceSync'

vi.mock('../../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

const initial: SkillsPayload = {
  skills: [
    {
      name: 'rca',
      tier: 'user',
      description: 'local adaptation',
      enabled: true,
      shadows: ['hivemind', 'bundled']
    },
    { name: 'my-notes', tier: 'user', description: 'plain user skill', enabled: true, shadows: [] },
    { name: 'hive-probe', tier: 'hivemind', description: 'probe', enabled: true, shadows: [] },
    { name: 'analyze-applog', tier: 'bundled', description: 'applog', enabled: true, shadows: [] }
  ]
}

const afterAdopt: SkillsPayload = {
  skills: [
    {
      name: 'rca',
      tier: 'hivemind',
      description: 'upstream rca',
      enabled: true,
      shadows: ['bundled']
    },
    { name: 'my-notes', tier: 'user', description: 'plain user skill', enabled: true, shadows: [] },
    { name: 'hive-probe', tier: 'hivemind', description: 'probe', enabled: true, shadows: [] },
    { name: 'analyze-applog', tier: 'bundled', description: 'applog', enabled: true, shadows: [] }
  ]
}

const ghOk = { installed: true, version: '2.62', authenticated: true, login: 'me', detail: '' }

function hivePayload(pushes: Record<string, { prUrl: string; pushedAt: string }>): unknown {
  return {
    repo: 'acme/hivemind',
    state: 'ready',
    error: null,
    headCommit: null,
    lastSynced: null,
    items: [
      {
        kind: 'reference',
        name: 'adasis.md',
        description: '',
        commit: 'abc',
        installed: true,
        installedCommit: 'abc',
        localTier: 'hivemind',
        updateAvailable: true
      },
      // regression fixture for Finding 2: a user-tier reference whose hive entry
      // (stale from a prior claim) still reports updateAvailable — the chip must
      // not follow it once the row is no longer hivemind-tracked.
      {
        kind: 'reference',
        name: 'team-tips.md',
        description: '',
        commit: 'def',
        installed: true,
        installedCommit: 'def',
        localTier: 'user',
        updateAvailable: true
      },
      // a hive-tier skill with an upstream update — the marker must mirror refRow's
      // (previously only references rendered it; see Finding 3).
      {
        kind: 'skill',
        name: 'hive-probe',
        description: 'probe',
        commit: 'ghi',
        installed: true,
        installedCommit: 'ghi',
        localTier: null,
        updateAvailable: true
      }
    ],
    pushable: [],
    pushes
  }
}

const refPayload: RefSyncPayload = {
  config: { spaces: [] } as unknown as RefSyncPayload['config'],
  loadError: null,
  cards: [],
  references: [
    { file: 'team-tips.md', tier: 'user', lastSynced: null, sourceCount: 0, stale: false },
    {
      file: 'nav-runbook.md',
      tier: 'confluence',
      lastSynced: '2026-07-20T00:00:00.000Z',
      sourceCount: 3,
      stale: true
    },
    {
      file: 'adasis.md',
      tier: 'hivemind',
      lastSynced: '2026-07-25T00:00:00.000Z',
      sourceCount: 0,
      stale: false
    }
  ]
}

function mockArgus(): {
  skills: {
    list: ReturnType<typeof vi.fn>
    deleteUser: ReturnType<typeof vi.fn>
    read: ReturnType<typeof vi.fn>
  }
  usage: { stats: ReturnType<typeof vi.fn> }
  access: { patch: ReturnType<typeof vi.fn> }
  hivemind: {
    get: ReturnType<typeof vi.fn>
    pushPreview: ReturnType<typeof vi.fn>
    push: ReturnType<typeof vi.fn>
    uninstallSkill: ReturnType<typeof vi.fn>
    uninstallReference: ReturnType<typeof vi.fn>
    claimReference: ReturnType<typeof vi.fn>
  }
  sourceControl: { status: ReturnType<typeof vi.fn> }
  refsync: {
    get: ReturnType<typeof vi.fn>
    onChanged: ReturnType<typeof vi.fn>
    searchRefs: ReturnType<typeof vi.fn>
    readRef: ReturnType<typeof vi.fn>
    deleteRef: ReturnType<typeof vi.fn>
  }
  openExternal: ReturnType<typeof vi.fn>
} {
  return {
    skills: {
      list: vi.fn().mockResolvedValue(initial),
      deleteUser: vi.fn().mockResolvedValue(afterAdopt),
      read: vi.fn().mockResolvedValue({ name: 'rca', content: '# rca skill body\n' })
    },
    usage: {
      stats: vi.fn().mockResolvedValue({
        hygiene: { staleDays: 45, minRecalls: 3, trackingStartedAt: '2026-01-01T00:00:00.000Z' },
        skills: [
          {
            name: 'rca',
            tier: 'user',
            enabled: true,
            activationCount: 12,
            lastActivatedAt: '2026-07-18T00:00:00.000Z'
          },
          {
            name: 'my-notes',
            tier: 'user',
            enabled: true,
            activationCount: 0,
            lastActivatedAt: null
          }
        ],
        memory: [],
        references: [
          { relPath: 'team-tips.md', readCount: 4, lastReadAt: '2026-07-21T00:00:00.000Z' }
        ],
        archived: []
      })
    },
    hivemind: {
      get: vi.fn().mockResolvedValue(
        hivePayload({
          'skill/my-notes': {
            prUrl: 'https://github.com/acme/hivemind/pull/9',
            pushedAt: '2026-07-22T10:00:00.000Z'
          }
        })
      ),
      pushPreview: vi.fn().mockResolvedValue('# rca'),
      push: vi
        .fn()
        .mockResolvedValue({ ok: true, prUrl: 'https://github.com/acme/hivemind/pull/12' }),
      uninstallSkill: vi.fn().mockResolvedValue(hivePayload({})),
      uninstallReference: vi.fn().mockResolvedValue(hivePayload({})),
      claimReference: vi.fn().mockResolvedValue(hivePayload({}))
    },
    sourceControl: { status: vi.fn().mockResolvedValue(ghOk) },
    access: {
      patch: vi.fn().mockResolvedValue({ access: { skills: {}, memory: {} }, loadError: null })
    },
    refsync: {
      get: vi.fn().mockResolvedValue(refPayload),
      onChanged: vi.fn(() => () => {}),
      searchRefs: vi.fn().mockResolvedValue([]),
      readRef: vi.fn().mockResolvedValue({ file: 'team-tips.md', content: '# Team tips\n' }),
      deleteRef: vi.fn().mockResolvedValue(undefined)
    },
    openExternal: vi.fn()
  }
}

let argus: ReturnType<typeof mockArgus>

beforeEach(() => {
  referenceSyncStore.reset()
  argus = mockArgus()
  ;(window as unknown as { argus: unknown }).argus = argus
  vi.mocked(confirm).mockResolvedValue(true)
})

describe('LibraryPage delete/adopt actions', () => {
  it('user skill shadowing hivemind gets "Adopt upstream"; confirm deletes and refreshes', async () => {
    render(<LibraryPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adopt upstream · rca' }))
    expect(confirm).toHaveBeenCalled()
    await waitFor(() => expect(argus.skills.deleteUser).toHaveBeenCalledWith('rca'))
    // list now shows the hivemind winner from the returned payload
    expect(await screen.findByText('upstream rca')).toBeInTheDocument()
    expect(screen.queryByText('local adaptation')).not.toBeInTheDocument()
  })

  it('plain user skill gets a Delete action', async () => {
    render(<LibraryPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete · my-notes' }))
    await waitFor(() => expect(argus.skills.deleteUser).toHaveBeenCalledWith('my-notes'))
  })

  it('cancelling the confirm leaves the skill alone', async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    render(<LibraryPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adopt upstream · rca' }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(argus.skills.deleteUser).not.toHaveBeenCalled()
  })

  it('hivemind skill Remove uninstalls after confirm and refreshes the list', async () => {
    render(<LibraryPage />)
    await screen.findByText('hive-probe')
    fireEvent.click(screen.getByRole('button', { name: 'Remove · hive-probe' }))
    await waitFor(() => expect(argus.hivemind.uninstallSkill).toHaveBeenCalledWith('hive-probe'))
    expect(argus.skills.list).toHaveBeenCalledTimes(2)
  })

  it('hand-owned reference Delete calls refsync.deleteRef; hive-managed gets uninstall', async () => {
    render(<LibraryPage />)
    await screen.findByText('team-tips.md')
    fireEvent.click(screen.getByRole('button', { name: 'Delete · team-tips.md' }))
    await waitFor(() => expect(argus.refsync.deleteRef).toHaveBeenCalledWith('team-tips.md'))

    fireEvent.click(screen.getByRole('button', { name: 'Remove · nav-runbook.md' }))
    await waitFor(() =>
      expect(argus.hivemind.uninstallReference).toHaveBeenCalledWith('nav-runbook.md')
    )
  })

  it('declined confirm is a no-op; bundled rows offer no removal', async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    render(<LibraryPage />)
    await screen.findByText('hive-probe')
    fireEvent.click(screen.getByRole('button', { name: 'Remove · hive-probe' }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(argus.hivemind.uninstallSkill).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Remove · analyze-applog' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete · analyze-applog' })).toBeNull()
  })

  it('a rejected delete surfaces an error and keeps the list', async () => {
    argus.skills.deleteUser = vi.fn().mockRejectedValue(new Error('EPERM: locked'))
    render(<LibraryPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adopt upstream · rca' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/EPERM: locked/)
    expect(screen.getByText('local adaptation')).toBeInTheDocument()
  })
})

describe('LibraryPage load failure', () => {
  it('a rejected skills.list surfaces an error instead of loading forever', async () => {
    argus.skills.list = vi.fn().mockRejectedValue(new Error('ipc dead'))
    render(<LibraryPage />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/ipc dead/)
    expect(screen.queryByText('loading…')).not.toBeInTheDocument()
  })
})

describe('LibraryPage usage stats', () => {
  it('shows activation count and last-used date per skill', async () => {
    render(<LibraryPage />)
    expect(await screen.findByText(/12× · last 2026-07-18/)).toBeInTheDocument()
  })
  it('flags never-activated skills', async () => {
    render(<LibraryPage />)
    expect(await screen.findByText('never activated')).toBeInTheDocument()
  })
  it('renders normally when usage stats fail', async () => {
    argus.usage.stats = vi.fn().mockRejectedValue(new Error('boom'))
    render(<LibraryPage />)
    expect(await screen.findByText('hive-probe')).toBeInTheDocument()
    expect(screen.queryByText('never activated')).not.toBeInTheDocument()
  })
})

describe('LibraryPage toggle', () => {
  it('toggle patches tier-qualified access key and refetches with the flipped state', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({
        skills: initial.skills.map((s) => (s.name === 'rca' ? { ...s, enabled: false } : s))
      })
    argus.skills.list = list

    render(<LibraryPage />)
    const toggle = await screen.findByRole('switch', { name: 'enabled · user/rca' })
    expect(toggle).toHaveProperty('ariaChecked', 'true')

    fireEvent.click(toggle)
    await waitFor(() =>
      expect(window.argus.access.patch).toHaveBeenCalledWith({ skills: { 'user/rca': false } })
    )
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'enabled · user/rca' })).toHaveProperty(
        'ariaChecked',
        'false'
      )
    )
  })
})

describe('LibraryPage merged list', () => {
  it('groups both kinds by rights, kind mixed within a group', async () => {
    render(<LibraryPage />)
    await screen.findByText('rca')

    const yoursSection = screen.getByText('Yours').closest('section')
    const subscribedSection = screen.getByText('Subscribed').closest('section')
    if (!yoursSection || !subscribedSection) throw new Error('group section not found')
    expect(screen.getByText('Built-in')).toBeInTheDocument()

    // Yours actually mixes a user-tier skill and the user-tier reference in the same group
    expect(within(yoursSection).getByText('my-notes')).toBeInTheDocument()
    expect(await within(yoursSection).findByText('team-tips.md')).toBeInTheDocument()

    // Subscribed actually mixes a hivemind skill and a confluence reference in the same group
    expect(within(subscribedSection).getByText('hive-probe')).toBeInTheDocument()
    expect(within(subscribedSection).getByText('nav-runbook.md')).toBeInTheDocument()

    // and neither leaks into the other group
    expect(within(yoursSection).queryByText('hive-probe')).toBeNull()
    expect(within(yoursSection).queryByText('nav-runbook.md')).toBeNull()
    expect(within(subscribedSection).queryByText('my-notes')).toBeNull()
    expect(within(subscribedSection).queryByText('team-tips.md')).toBeNull()

    // no five-way vocabulary survives as a group heading
    expect(screen.queryByText('User')).toBeNull()
    expect(screen.queryByText('Team knowledge')).toBeNull()
    expect(screen.queryByText('Bundled')).toBeNull()
  })

  it('each group states the rights it confers', async () => {
    render(<LibraryPage />)
    await screen.findByText('rca')
    expect(
      screen.getByText('You own these. Edit, delete, or share them with your team.')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Owned upstream and kept current. Claim one to make it yours.')
    ).toBeInTheDocument()
    expect(screen.getByText('Ships with an installed pack.')).toBeInTheDocument()
  })

  it('user skill shadowing lower tiers carries an overrides chip', async () => {
    render(<LibraryPage />)
    await screen.findByText('rca')
    expect(screen.getByText('overrides HiveMind, pack')).toBeInTheDocument()
    // non-shadowing rows get no such chip
    expect(screen.getAllByText(/^overrides /)).toHaveLength(1)
  })

  it('every row carries a kind chip', async () => {
    render(<LibraryPage />)
    await screen.findByText('rca')
    expect(screen.getAllByText('skill').length).toBeGreaterThanOrEqual(4)
    expect(screen.getAllByText('reference').length).toBe(3)
  })

  it('clicking a reference row opens the markdown viewer', async () => {
    render(<LibraryPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'open · team-tips.md' }))
    expect(await screen.findByRole('dialog', { name: /team-tips\.md/ })).toBeInTheDocument()
  })

  it('reference rows show stale chip and read-count usage', async () => {
    render(<LibraryPage />)
    await screen.findByText('nav-runbook.md')
    expect(screen.getByText('stale')).toBeInTheDocument()
    expect(await screen.findByText(/4 reads/)).toBeInTheDocument()
  })

  it('flags never-read reference files (present zero-count usage entry)', async () => {
    argus.usage.stats = vi.fn().mockResolvedValue({
      hygiene: { staleDays: 45, minRecalls: 3, trackingStartedAt: '2026-01-01T00:00:00.000Z' },
      skills: [],
      memory: [],
      references: [{ relPath: 'nav-runbook.md', readCount: 0, lastReadAt: null }],
      archived: []
    })
    render(<LibraryPage />)
    await screen.findByText('nav-runbook.md')
    expect(await screen.findByText(/never read/)).toBeInTheDocument()
  })

  it('empty Yours group teaches where content comes from', async () => {
    argus.skills.list.mockResolvedValue({ skills: [] })
    argus.refsync.get.mockResolvedValue({ ...refPayload, references: [] })
    render(<LibraryPage />)
    expect(
      await screen.findByText(
        "Nothing yet — accept an agent proposal, or claim something from your team's HiveMind."
      )
    ).toBeInTheDocument()
  })

  it('rows in Yours and Subscribed badge their origin; Built-in rows do not', async () => {
    render(<LibraryPage />)
    await screen.findByText('rca')
    // user-tier skill + user-tier reference
    expect(screen.getAllByText('you').length).toBe(3)
    // hivemind skill, confluence reference
    expect(screen.getAllByText('HiveMind').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Confluence')).toBeInTheDocument()
    // the bundled skill sits alone in Built-in and carries no origin badge
    expect(screen.queryByText('pack')).toBeNull()
  })

  it('clicking a skill name opens the skill viewer with SKILL.md content', async () => {
    render(<LibraryPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'open · rca' }))
    await waitFor(() => expect(argus.skills.read).toHaveBeenCalledWith('rca'))
    expect(await screen.findByText('rca skill body')).toBeInTheDocument()
  })

  it('reference rows keep their meta line and stay openable', async () => {
    render(<LibraryPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'open · team-tips.md' }))
    expect(await screen.findByText('Team tips')).toBeInTheDocument()
  })
})

/** The row `<div class="group/row …">` ancestor of a labelled row's open button, for scoped assertions. */
async function findRow(label: string): Promise<HTMLElement> {
  const opener = await screen.findByRole('button', { name: `open · ${label}` })
  const row = opener.closest('[class*="group/row"]')
  if (!row) throw new Error(`no row container found for ${label}`)
  return row as HTMLElement
}

describe('LibraryPage claim', () => {
  it('a hivemind reference offers Claim and calls through after confirm', async () => {
    render(<LibraryPage />)
    const btn = await screen.findByRole('button', { name: 'Claim · adasis.md' })
    fireEvent.click(btn)
    await waitFor(() => expect(argus.hivemind.claimReference).toHaveBeenCalledWith('adasis.md'))
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmLabel: 'Claim',
        message: expect.stringContaining('stop appearing in this list')
      })
    )
  })

  it('a declined confirm claims nothing', async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false)
    render(<LibraryPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Claim · adasis.md' }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(argus.hivemind.claimReference).not.toHaveBeenCalled()
  })

  it('a confluence reference offers no Claim', async () => {
    render(<LibraryPage />)
    await screen.findByText('nav-runbook.md')
    expect(screen.queryByRole('button', { name: 'Claim · nav-runbook.md' })).toBeNull()
  })

  it('an upstream update shows on the hivemind reference row, scoped to that row', async () => {
    render(<LibraryPage />)
    const row = await findRow('adasis.md')
    expect(within(row).getByText('update')).toBeInTheDocument()
    // exactly two rows in the whole page carry the chip: this reference and the
    // hive-probe skill below
    expect(screen.getAllByText('update')).toHaveLength(2)
  })

  it('an upstream update shows on the hivemind skill row too, scoped to that row', async () => {
    render(<LibraryPage />)
    const row = await findRow('hive-probe')
    expect(within(row).getByText('update')).toBeInTheDocument()
    expect(screen.getAllByText('update')).toHaveLength(2)
  })

  it('a claimed (user-tier) reference with a stale updateAvailable hive entry shows no update chip', async () => {
    render(<LibraryPage />)
    const row = await findRow('team-tips.md')
    expect(within(row).queryByText('update')).toBeNull()
  })

  it('a failed claim surfaces in the alert banner', async () => {
    argus.hivemind.claimReference = vi.fn().mockRejectedValue(new Error('claim exploded'))
    render(<LibraryPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Claim · adasis.md' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/claim exploded/)
  })
})
