// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { HivemindSettings } from '../HivemindSettings'
import { settingsStore } from '../../../lib/settingsStore'
import { defaultSettings } from '../../../../../shared/settings'
import type { HivemindPayload } from '../../../../../shared/hivemind'
import type { SettingsPayload } from '../../../../../shared/settings'

function settingsPayload(repo: string): SettingsPayload {
  return {
    settings: { ...defaultSettings(), hivemind: { repo } },
    resolvedTools: {
      traceDir: { value: null, source: 'default' },
      parseBin: { value: null, source: 'default' }
    },
    dataRoot: { path: 'C:/tmp/argus', fromEnv: false },
    loadError: null
  }
}

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
      diff: vi
        .fn()
        .mockResolvedValue(
          'diff --git a/skills/x b/skills/x\n@@ -1,2 +1,2 @@\n context\n-old\n+new'
        ),
      pushPreview: vi.fn().mockResolvedValue('# my-skill'),
      push: vi
        .fn()
        .mockResolvedValue({ ok: true, prUrl: 'https://github.com/acme/hivemind/pull/7' }),
      check: vi.fn().mockResolvedValue({ ok: true })
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
  vi.spyOn(settingsStore, 'patch').mockResolvedValue(undefined as never)
})

function openShareTab(): void {
  fireEvent.click(screen.getByRole('tab', { name: 'Share to HiveMind' }))
}

describe('HivemindSettings', () => {
  it('dormant state shows the repo input, not a pointer to General', async () => {
    ;(window as unknown as { argus: unknown }).argus = mockArgus({
      ...ready,
      repo: '',
      state: 'dormant',
      items: [],
      headCommit: null
    })
    render(<HivemindSettings payload={settingsPayload('')} />)
    expect(await screen.findByText(/Set a HiveMind repo/)).toBeInTheDocument()
    expect(screen.queryByText(/General/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('HiveMind repo')).toBeInTheDocument()
  })

  it('repo row commits hivemind.repo on blur', async () => {
    render(<HivemindSettings payload={settingsPayload('')} />)
    const input = await screen.findByLabelText('HiveMind repo')
    fireEvent.change(input, { target: { value: 'acme/hivemind' } })
    fireEvent.blur(input)
    expect(settingsStore.patch).toHaveBeenCalledWith({ hivemind: { repo: 'acme/hivemind' } })
  })

  it('not-cloned state offers Sync', async () => {
    ;(window as unknown as { argus: unknown }).argus = mockArgus({
      ...ready,
      state: 'not-cloned',
      items: [],
      headCommit: null
    })
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    expect(await screen.findByRole('button', { name: 'Sync' })).toBeInTheDocument()
  })

  it('ready state lists items under separate Skills/References headings, flags updates, installs on click', async () => {
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    expect(await screen.findByText('hive-probe')).toBeInTheDocument()
    expect(screen.getByText('Skills')).toBeInTheDocument()
    expect(screen.getByText('References')).toBeInTheDocument()
    expect(screen.getByText('update available')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Install hive-note.md' }))
    await waitFor(() =>
      expect(
        (window as unknown as { argus: { hivemind: { install: ReturnType<typeof vi.fn> } } }).argus
          .hivemind.install
      ).toHaveBeenCalledWith('reference', 'hive-note.md')
    )
  })

  it('update flow expands the diff directly below the clicked row and re-installs through it', async () => {
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    const row = await screen.findByText('hive-probe')
    fireEvent.click(screen.getByRole('button', { name: 'Update hive-probe' }))
    // real @@-bearing diff renders the split view, not the plain <pre> fallback
    expect(await screen.findByRole('group', { name: 'diff view mode' })).toBeInTheDocument()
    const diff = await screen.findByText('old')
    expect(await screen.findByText('new')).toBeInTheDocument()
    // inline placement: the diff panel follows the item's row in DOM order
    expect(row.compareDocumentPosition(diff) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Re-install hive-probe' }))
    await waitFor(() =>
      expect(
        (window as unknown as { argus: { hivemind: { install: ReturnType<typeof vi.fn> } } }).argus
          .hivemind.install
      ).toHaveBeenCalledWith('skill', 'hive-probe')
    )
  })

  it('filter input narrows visible rows by name and description', async () => {
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    await screen.findByText('hive-probe')
    expect(screen.getByText('hive-note.md')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Filter HiveMind content'), {
      target: { value: 'probe' }
    })

    expect(screen.getByText('hive-probe')).toBeInTheDocument()
    expect(screen.queryByText('hive-note.md')).not.toBeInTheDocument()
    // no reference items match "probe" — the References section disappears entirely
    expect(screen.queryByText('References')).not.toBeInTheDocument()
  })

  it('no-match state shows dim message when filter matches nothing in both lists', async () => {
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    await screen.findByText('hive-probe')

    // Type non-matching filter
    fireEvent.change(screen.getByLabelText('Filter HiveMind content'), {
      target: { value: 'zzz' }
    })

    // Both lists should be empty, no-match message should appear
    expect(screen.getByText('No HiveMind content matches "zzz".')).toBeInTheDocument()
    expect(screen.queryByText('hive-probe')).not.toBeInTheDocument()
    expect(screen.queryByText('hive-note.md')).not.toBeInTheDocument()

    // Clear filter - rows come back
    fireEvent.change(screen.getByLabelText('Filter HiveMind content'), {
      target: { value: '' }
    })

    expect(screen.queryByText('No HiveMind content matches')).not.toBeInTheDocument()
    expect(screen.getByText('hive-probe')).toBeInTheDocument()
    expect(screen.getByText('hive-note.md')).toBeInTheDocument()
  })

  it('push confirm shows the preview and links the PR afterwards', async () => {
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    await screen.findByText('hive-probe')
    openShareTab()
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
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/clone diverged/)
  })

  it('surfaces a rejected diff fetch when opening the update flow', async () => {
    const argus = mockArgus(ready)
    ;(argus.hivemind as { diff: ReturnType<typeof vi.fn> }).diff = vi
      .fn()
      .mockRejectedValue(new Error('git exploded'))
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
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
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    expect(await screen.findByText(/GitHub CLI/)).toBeInTheDocument()
    expect(await screen.findByText('hive-probe')).toBeInTheDocument()
  })

  it('rejected push clears busy and surfaces error, keeping Sync enabled', async () => {
    const argus = mockArgus(ready)
    ;(argus.hivemind as { push: ReturnType<typeof vi.fn> }).push = vi
      .fn()
      .mockRejectedValue(new Error('push exploded'))
    ;(window as unknown as { argus: unknown }).argus = argus
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    await screen.findByText('hive-probe')
    openShareTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Push my-skill' }))
    expect(await screen.findByText('# my-skill')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open pull request' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/push exploded/)
    expect(screen.getByRole('button', { name: 'Sync' })).not.toBeDisabled()
  })

  it('refetches the hivemind payload when the repo setting changes', async () => {
    const { rerender } = render(<HivemindSettings payload={settingsPayload('org/hive')} />)
    await waitFor(() => expect(window.argus.hivemind.get).toHaveBeenCalledTimes(1))
    rerender(<HivemindSettings payload={settingsPayload('org/other')} />)
    await waitFor(() => expect(window.argus.hivemind.get).toHaveBeenCalledTimes(2))
  })

  it('shows readiness feedback for the configured repo', async () => {
    window.argus.hivemind.check = vi.fn().mockResolvedValue({ ok: false, error: 'no access' })
    render(<HivemindSettings payload={settingsPayload('org/hive')} />)
    expect(await screen.findByText('not reachable')).toBeInTheDocument()
  })

  it('renders the repo as an external link for org/name slugs', async () => {
    render(<HivemindSettings payload={settingsPayload('org/hive')} />)
    fireEvent.click(await screen.findByRole('button', { name: /open org\/hive on github/i }))
    expect(window.argus.openExternal).toHaveBeenCalledWith('https://github.com/org/hive')
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
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
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
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
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
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
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
    render(<HivemindSettings payload={settingsPayload('acme/hivemind')} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Keep hive-note.md as mine' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/claim exploded/)
  })
})
