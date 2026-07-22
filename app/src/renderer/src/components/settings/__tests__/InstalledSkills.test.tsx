// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { InstalledSkills } from '../InstalledSkills'
import { confirm } from '../../../lib/confirmStore'
import type { SkillsPayload } from '../../../../../shared/memoryIpc'

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

function mockArgus(): {
  skills: { list: ReturnType<typeof vi.fn>; deleteUser: ReturnType<typeof vi.fn> }
  usage: { stats: ReturnType<typeof vi.fn> }
  hivemind: {
    get: ReturnType<typeof vi.fn>
    pushPreview: ReturnType<typeof vi.fn>
    push: ReturnType<typeof vi.fn>
  }
  sourceControl: { status: ReturnType<typeof vi.fn> }
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
        references: [],
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
    openExternal: vi.fn()
  }
}

let argus: ReturnType<typeof mockArgus>

beforeEach(() => {
  argus = mockArgus()
  ;(window as unknown as { argus: unknown }).argus = argus
  vi.mocked(confirm).mockResolvedValue(true)
})

describe('InstalledSkills delete/adopt actions', () => {
  it('user skill shadowing hivemind gets "Adopt upstream"; confirm deletes and refreshes', async () => {
    render(<InstalledSkills />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adopt upstream · rca' }))
    expect(confirm).toHaveBeenCalled()
    await waitFor(() => expect(argus.skills.deleteUser).toHaveBeenCalledWith('rca'))
    // list now shows the hivemind winner from the returned payload
    expect(await screen.findByText('upstream rca')).toBeInTheDocument()
    expect(screen.queryByText('local adaptation')).not.toBeInTheDocument()
  })

  it('plain user skill gets a Delete action', async () => {
    render(<InstalledSkills />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete · my-notes' }))
    await waitFor(() => expect(argus.skills.deleteUser).toHaveBeenCalledWith('my-notes'))
  })

  it('cancelling the confirm leaves the skill alone', async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    render(<InstalledSkills />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adopt upstream · rca' }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(argus.skills.deleteUser).not.toHaveBeenCalled()
  })

  it('hivemind and bundled rows offer no delete action', async () => {
    render(<InstalledSkills />)
    await screen.findByText('hive-probe')
    expect(screen.queryByRole('button', { name: /hive-probe/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /analyze-applog/ })).not.toBeInTheDocument()
  })

  it('a rejected delete surfaces an error and keeps the list', async () => {
    argus.skills.deleteUser = vi.fn().mockRejectedValue(new Error('EPERM: locked'))
    render(<InstalledSkills />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adopt upstream · rca' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/EPERM: locked/)
    expect(screen.getByText('local adaptation')).toBeInTheDocument()
  })
})

describe('InstalledSkills usage stats', () => {
  it('shows activation count and last-used date per skill', async () => {
    render(<InstalledSkills />)
    expect(await screen.findByText(/12× · last 2026-07-18/)).toBeInTheDocument()
  })
  it('flags never-activated skills', async () => {
    render(<InstalledSkills />)
    expect(await screen.findByText('never activated')).toBeInTheDocument()
  })
  it('renders normally when usage stats fail', async () => {
    argus.usage.stats = vi.fn().mockRejectedValue(new Error('boom'))
    render(<InstalledSkills />)
    expect(await screen.findByText('hive-probe')).toBeInTheDocument()
    expect(screen.queryByText('never activated')).not.toBeInTheDocument()
  })
})

describe('InstalledSkills share-in-place', () => {
  it('user-tier rows get a Share button (enabled when repo + gh are ready); other tiers do not', async () => {
    render(<InstalledSkills />)
    const share = await screen.findByRole('button', { name: 'Share rca to HiveMind' })
    await waitFor(() => expect(share).not.toBeDisabled())
    expect(screen.getByRole('button', { name: 'Share my-notes to HiveMind' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Share hive-probe to HiveMind' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Share analyze-applog to HiveMind' })
    ).not.toBeInTheDocument()
  })

  it('Share is disabled with a HiveMind pointer when gh is not authenticated', async () => {
    argus.sourceControl.status = vi
      .fn()
      .mockResolvedValue({ ...ghOk, installed: false, authenticated: false })
    render(<InstalledSkills />)
    const share = await screen.findByRole('button', { name: 'Share rca to HiveMind' })
    expect(share).toBeDisabled()
    expect(share).toHaveAttribute('title', expect.stringMatching(/Settings → HiveMind/))
  })

  it('Share is disabled when no HiveMind repo is configured', async () => {
    argus.hivemind.get = vi.fn().mockResolvedValue({
      repo: '',
      state: 'dormant',
      error: null,
      headCommit: null,
      lastSynced: null,
      items: [],
      pushable: [],
      pushes: {}
    })
    render(<InstalledSkills />)
    const share = await screen.findByRole('button', { name: 'Share rca to HiveMind' })
    expect(share).toBeDisabled()
  })

  it('Share opens the push dialog inline; push links the PR; closing refetches receipts', async () => {
    render(<InstalledSkills />)
    const share = await screen.findByRole('button', { name: 'Share rca to HiveMind' })
    await waitFor(() => expect(share).not.toBeDisabled())
    fireEvent.click(share)
    expect(await screen.findByText('# rca')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open pull request' }))
    await waitFor(() => expect(argus.hivemind.push).toHaveBeenCalledWith('skill', 'rca', 'Add rca'))
    expect(await screen.findByRole('button', { name: /pull\/12/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(argus.hivemind.get).toHaveBeenCalledTimes(2))
  })

  it('a push receipt renders a PR chip that opens externally', async () => {
    render(<InstalledSkills />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open PR · my-notes' }))
    expect(argus.openExternal).toHaveBeenCalledWith('https://github.com/acme/hivemind/pull/9')
    expect(screen.queryByRole('button', { name: 'Open PR · rca' })).not.toBeInTheDocument()
  })

  it('Share buttons disable while any push is in flight; re-enable when it settles', async () => {
    let pushResolve: (v: unknown) => void
    const pushPromise = new Promise((resolve) => {
      pushResolve = resolve
    })
    argus.hivemind.push = vi.fn().mockReturnValue(pushPromise)
    render(<InstalledSkills />)
    const shareRca = await screen.findByRole('button', { name: 'Share rca to HiveMind' })
    const shareNotes = screen.getByRole('button', { name: 'Share my-notes to HiveMind' })
    await waitFor(() => expect(shareRca).not.toBeDisabled())
    // Click Share on rca and start the push
    fireEvent.click(shareRca)
    expect(await screen.findByText('# rca')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open pull request' }))
    // While push is in flight, my-notes Share button should be disabled
    await waitFor(() => expect(shareNotes).toBeDisabled())
    // Resolve the push
    pushResolve!({ ok: true, prUrl: 'https://github.com/acme/hivemind/pull/12' })
    // After push settles, my-notes Share button should re-enable
    await waitFor(() => expect(shareNotes).not.toBeDisabled())
  })
})
