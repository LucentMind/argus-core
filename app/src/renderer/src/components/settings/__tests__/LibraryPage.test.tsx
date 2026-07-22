// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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
    items: [],
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
    }
  ]
}

function mockArgus(): {
  skills: { list: ReturnType<typeof vi.fn>; deleteUser: ReturnType<typeof vi.fn> }
  usage: { stats: ReturnType<typeof vi.fn> }
  access: { patch: ReturnType<typeof vi.fn> }
  hivemind: {
    get: ReturnType<typeof vi.fn>
    pushPreview: ReturnType<typeof vi.fn>
    push: ReturnType<typeof vi.fn>
  }
  sourceControl: { status: ReturnType<typeof vi.fn> }
  refsync: {
    get: ReturnType<typeof vi.fn>
    onChanged: ReturnType<typeof vi.fn>
    searchRefs: ReturnType<typeof vi.fn>
    readRef: ReturnType<typeof vi.fn>
  }
  openExternal: ReturnType<typeof vi.fn>
} {
  return {
    skills: {
      list: vi.fn().mockResolvedValue(initial),
      deleteUser: vi.fn().mockResolvedValue(afterAdopt)
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
        .mockResolvedValue({ ok: true, prUrl: 'https://github.com/acme/hivemind/pull/12' })
    },
    sourceControl: { status: vi.fn().mockResolvedValue(ghOk) },
    access: {
      patch: vi.fn().mockResolvedValue({ access: { skills: {}, memory: {} }, loadError: null })
    },
    refsync: {
      get: vi.fn().mockResolvedValue(refPayload),
      onChanged: vi.fn(() => () => {}),
      searchRefs: vi.fn().mockResolvedValue([]),
      readRef: vi.fn().mockResolvedValue({ file: 'team-tips.md', content: '# Team tips\n' })
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

  it('hivemind and bundled rows offer no delete action', async () => {
    render(<LibraryPage />)
    await screen.findByText('hive-probe')
    expect(screen.queryByRole('button', { name: /hive-probe/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /analyze-applog/ })).not.toBeInTheDocument()
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
  it('groups both kinds by tier, kind mixed within a group', async () => {
    render(<LibraryPage />)
    await screen.findByText('rca')
    // user group holds user skills AND the user-tier reference
    const userSection = screen.getByText('User').closest('section') ?? document.body
    expect(await screen.findByText('team-tips.md')).toBeInTheDocument()
    expect(screen.getByText('my-notes')).toBeInTheDocument()
    // confluence-tier reference lands in its own group
    expect(screen.getByText('Confluence')).toBeInTheDocument()
    expect(screen.getByText('nav-runbook.md')).toBeInTheDocument()
    // bundled skill grouped under Bundled
    expect(screen.getByText('Bundled')).toBeInTheDocument()
    expect(userSection).toBeTruthy()
  })

  it('every row carries a kind chip', async () => {
    render(<LibraryPage />)
    await screen.findByText('rca')
    expect(screen.getAllByText('skill').length).toBeGreaterThanOrEqual(4)
    expect(screen.getAllByText('reference').length).toBe(2)
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

  it('empty user group teaches where content comes from', async () => {
    argus.skills.list.mockResolvedValue({ skills: [] })
    argus.refsync.get.mockResolvedValue({ ...refPayload, references: [] })
    render(<LibraryPage />)
    expect(
      await screen.findByText(
        'Nothing here yet — skills and references you accept from agent proposals land here.'
      )
    ).toBeInTheDocument()
  })
})
