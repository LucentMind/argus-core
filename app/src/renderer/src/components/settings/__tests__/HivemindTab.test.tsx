// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
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
      updateAvailable: true
    },
    {
      kind: 'reference',
      name: 'hive-note.md',
      description: '',
      commit: 'sha-3',
      installed: false,
      installedCommit: null,
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
})
