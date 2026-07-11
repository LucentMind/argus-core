// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { HivemindTab } from '../HivemindTab'
import type { HivemindPayload } from '../../../../../shared/hivemind'

const ready: HivemindPayload = {
  repo: 'acme/hivemind',
  state: 'ready',
  error: null,
  headCommit: 'headsha1234567',
  lastSynced: '2026-07-10T12:00:00.000Z',
  items: [
    {
      kind: 'skill',
      name: 'hive-probe',
      description: 'probe skill',
      commit: 'sha-2',
      installed: true,
      installedCommit: 'sha-1',
      localTier: null,
      updateAvailable: true
    },
    {
      kind: 'reference',
      name: 'hive-note.md',
      description: '',
      commit: 'sha-3',
      installed: false,
      installedCommit: null,
      localTier: null,
      updateAvailable: false
    }
  ],
  pushable: [{ kind: 'skill', name: 'my-skill' }]
}

function mockArgus(payload: HivemindPayload): Record<string, unknown> {
  return {
    hivemind: {
      get: vi.fn().mockResolvedValue(payload),
      sync: vi.fn().mockResolvedValue(payload),
      install: vi.fn().mockResolvedValue(payload),
      claimReference: vi.fn().mockResolvedValue(payload),
      diff: vi.fn().mockResolvedValue('+ new line'),
      pushPreview: vi.fn().mockResolvedValue('# my-skill'),
      push: vi
        .fn()
        .mockResolvedValue({ ok: true, prUrl: 'https://github.com/acme/hivemind/pull/7' })
    },
    sourceControl: {
      status: vi.fn().mockResolvedValue({
        installed: true,
        version: '2.62',
        authenticated: true,
        login: 'me',
        detail: ''
      })
    },
    openExternal: vi.fn()
  }
}

beforeEach(() => {
  ;(window as unknown as { argus: unknown }).argus = mockArgus(ready)
})

describe('HivemindTab', () => {
  it('dormant state points at the setting', async () => {
    ;(window as unknown as { argus: unknown }).argus = mockArgus({
      ...ready,
      repo: '',
      state: 'dormant',
      items: [],
      headCommit: null
    })
    render(<HivemindTab />)
    expect(await screen.findByText(/Set a HiveMind repo/)).toBeInTheDocument()
  })

  it('not-cloned state offers Sync', async () => {
    ;(window as unknown as { argus: unknown }).argus = mockArgus({
      ...ready,
      state: 'not-cloned',
      items: [],
      headCommit: null
    })
    render(<HivemindTab />)
    expect(await screen.findByRole('button', { name: 'Sync' })).toBeInTheDocument()
  })

  it('ready state lists items, flags updates, installs on click', async () => {
    render(<HivemindTab />)
    expect(await screen.findByText('hive-probe')).toBeInTheDocument()
    expect(screen.getByText('update available')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Install hive-note.md' }))
    await waitFor(() =>
      expect(
        (window as unknown as { argus: { hivemind: { install: ReturnType<typeof vi.fn> } } }).argus
          .hivemind.install
      ).toHaveBeenCalledWith('reference', 'hive-note.md')
    )
  })

  it('update flow shows the diff and re-installs through it', async () => {
    render(<HivemindTab />)
    fireEvent.click(await screen.findByRole('button', { name: 'Update hive-probe' }))
    expect(await screen.findByText('+ new line')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Re-install hive-probe' }))
    await waitFor(() =>
      expect(
        (window as unknown as { argus: { hivemind: { install: ReturnType<typeof vi.fn> } } }).argus
          .hivemind.install
      ).toHaveBeenCalledWith('skill', 'hive-probe')
    )
  })

  it('push confirm shows the preview and links the PR afterwards', async () => {
    render(<HivemindTab />)
    fireEvent.click(await screen.findByRole('button', { name: 'Push my-skill' }))
    expect(await screen.findByText('# my-skill')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open pull request' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /pull\/7/ })).toBeInTheDocument())
  })

  it('surfaces an initial-load error from a bad hivemind.get payload', async () => {
    const argus = mockArgus(ready)
    ;(argus.hivemind as { get: ReturnType<typeof vi.fn> }).get = vi.fn().mockResolvedValue({
      ...ready,
      state: 'error',
      error: 'clone diverged',
      items: [],
      pushable: []
    })
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindTab />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/clone diverged/)
  })

  it('surfaces a rejected diff fetch when opening the update flow', async () => {
    const argus = mockArgus(ready)
    ;(argus.hivemind as { diff: ReturnType<typeof vi.fn> }).diff = vi
      .fn()
      .mockRejectedValue(new Error('git exploded'))
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindTab />)
    fireEvent.click(await screen.findByRole('button', { name: 'Update hive-probe' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/git exploded/)
    expect(screen.queryByText('+ new line')).not.toBeInTheDocument()
  })

  it('unauthenticated gh renders the Health pointer without hiding the browse list', async () => {
    const argus = mockArgus(ready)
    ;(argus.sourceControl as { status: ReturnType<typeof vi.fn> }).status = vi
      .fn()
      .mockResolvedValue({
        installed: false,
        version: null,
        authenticated: false,
        login: null,
        detail: ''
      })
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindTab />)
    expect(await screen.findByText(/GitHub CLI/)).toBeInTheDocument()
    expect(await screen.findByText('hive-probe')).toBeInTheDocument()
  })

  it('rejected push clears busy and surfaces error, keeping Sync enabled', async () => {
    const argus = mockArgus(ready)
    ;(argus.hivemind as { push: ReturnType<typeof vi.fn> }).push = vi
      .fn()
      .mockRejectedValue(new Error('push exploded'))
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindTab />)
    fireEvent.click(await screen.findByRole('button', { name: 'Push my-skill' }))
    expect(await screen.findByText('# my-skill')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open pull request' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/push exploded/)
    expect(screen.getByRole('button', { name: 'Sync' })).not.toBeDisabled()
  })
})

describe('keep as mine', () => {
  const claimable: HivemindPayload = {
    ...ready,
    items: [
      {
        kind: 'reference',
        name: 'hive-note.md',
        description: '',
        commit: 'sha-3',
        installed: true,
        installedCommit: 'sha-3',
        localTier: 'hivemind',
        updateAvailable: false
      }
    ]
  }

  afterEach(() => vi.restoreAllMocks())

  it('claims an installed hivemind-tier reference after confirm', async () => {
    const argus = mockArgus(claimable)
    ;(window as unknown as { argus: unknown }).argus = argus
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<HivemindTab />)
    fireEvent.click(await screen.findByRole('button', { name: 'Keep hive-note.md as mine' }))
    await waitFor(() =>
      expect(
        (argus.hivemind as { claimReference: ReturnType<typeof vi.fn> }).claimReference
      ).toHaveBeenCalledWith('hive-note.md')
    )
  })

  it('confirm-cancel is a no-op', async () => {
    const argus = mockArgus(claimable)
    ;(window as unknown as { argus: unknown }).argus = argus
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<HivemindTab />)
    fireEvent.click(await screen.findByRole('button', { name: 'Keep hive-note.md as mine' }))
    expect(
      (argus.hivemind as { claimReference: ReturnType<typeof vi.fn> }).claimReference
    ).not.toHaveBeenCalled()
  })

  it('hides the button for user-tier and uninstalled references', async () => {
    const argus = mockArgus({
      ...claimable,
      items: [
        { ...claimable.items[0], localTier: 'user' },
        { ...claimable.items[0], name: 'other.md', installed: false, localTier: null }
      ]
    })
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindTab />)
    expect(await screen.findByText('hive-note.md')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /as mine/ })).not.toBeInTheDocument()
  })

  it('a rejected claim surfaces in the alert banner', async () => {
    const argus = mockArgus(claimable)
    ;(argus.hivemind as { claimReference: ReturnType<typeof vi.fn> }).claimReference = vi
      .fn()
      .mockRejectedValue(new Error('claim exploded'))
    ;(window as unknown as { argus: unknown }).argus = argus
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<HivemindTab />)
    fireEvent.click(await screen.findByRole('button', { name: 'Keep hive-note.md as mine' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/claim exploded/)
  })
})
