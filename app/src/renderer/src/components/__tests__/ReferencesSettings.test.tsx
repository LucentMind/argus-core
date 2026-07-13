// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { it, expect, vi, beforeEach } from 'vitest'
import { ReferencesSettings } from '../settings/ReferencesSettings'
import { referenceSyncStore } from '../../lib/referenceSyncStore'
import { connectorsStore } from '../../lib/connectorsStore'
import type { RefSyncPayload } from '../../../../shared/referenceSync'
import type { ConnectorsPayload } from '../../../../shared/connectors'

const payload: RefSyncPayload = {
  config: {
    spaces: [
      {
        key: 'NAVNATIVE',
        name: 'Nav Native',
        homepageId: '100',
        includeRoots: ['100'],
        excludedSubtrees: [],
        routingRules: []
      }
    ],
    outdatedWindowMonths: 12,
    mustKeep: {}
  },
  loadError: null,
  cards: [
    {
      key: 'NAVNATIVE',
      name: 'Nav Native',
      pageCount: 4,
      lastSyncedAt: '2026-06-01T00:00:00.000Z',
      stale: true,
      driftTargets: ['routing-flow.md']
    }
  ],
  references: [
    {
      file: 'routing-flow.md',
      tier: 'confluence',
      lastSynced: '2026-06-01T00:00:00.000Z',
      sourceCount: 2,
      stale: true
    },
    { file: 'glossary.md', tier: 'team-knowledge', lastSynced: null, sourceCount: 0, stale: false }
  ]
}

const connectorsPayload: ConnectorsPayload = {
  connectors: {
    rovo: {
      kind: 'http',
      displayName: 'Atlassian Rovo',
      preset: 'rovo',
      enabled: true,
      config: { siteUrl: 'https://example.atlassian.net', apiToken: { $secret: 'rovo/apiToken' } }
    }
  },
  runtime: {},
  oauth: {},
  rest: {},
  loadError: null,
  secretsAvailable: true,
  secretsLoadError: null,
  presets: {}
}

beforeEach(() => {
  referenceSyncStore.reset()
  connectorsStore.reset()
  ;(window as unknown as { argus: unknown }).argus = {
    refsync: {
      get: vi.fn(async () => payload),
      onChanged: vi.fn(() => () => undefined),
      onProgress: vi.fn(() => () => undefined),
      sync: vi.fn(async () => ({ ok: false, code: 'auth', message: 'PAT rejected' })),
      removeSpace: vi.fn(async () => payload),
      searchRefs: vi.fn(async () => ['routing-flow.md']),
      readRef: vi.fn(async () => ({ file: 'glossary.md', content: '# Glossary\n\nterms\n' }))
    },
    connectors: {
      get: vi.fn(async () => connectorsPayload),
      patch: vi.fn(async () => connectorsPayload),
      test: vi.fn().mockResolvedValue({ ok: true, tools: [] }),
      oauth: vi.fn().mockResolvedValue({ ok: true }),
      onChanged: vi.fn(() => () => undefined)
    }
  }
})

it('renders space cards with staleness and reference statuses', async () => {
  render(<ReferencesSettings />)
  expect(await screen.findByText('Nav Native')).toBeTruthy()
  expect(screen.getAllByText('stale').length).toBeGreaterThan(0)
  expect(screen.getByText('glossary.md')).toBeTruthy()
  expect(screen.getByText('team-knowledge')).toBeTruthy()
})

it('Sync now surfaces a REST auth failure inline', async () => {
  render(<ReferencesSettings />)
  fireEvent.click(await screen.findByRole('button', { name: 'sync · NAVNATIVE' }))
  await waitFor(() => expect(window.argus.refsync.sync).toHaveBeenCalledWith('NAVNATIVE'))
  expect(await screen.findByText(/PAT rejected/)).toBeTruthy()
})

it('shows the broken-config banner from loadError', async () => {
  ;(window.argus.refsync.get as ReturnType<typeof vi.fn>).mockResolvedValue({
    ...payload,
    loadError: 'Unexpected token'
  })
  render(<ReferencesSettings />)
  expect(await screen.findByRole('alert')).toBeTruthy()
})

it('search filters the reference list via refsync:search-refs (name + content)', async () => {
  render(<ReferencesSettings />)
  expect(await screen.findByText('glossary.md')).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: 'search references' }), {
    target: { value: 'scheduler' }
  })
  await waitFor(() => expect(window.argus.refsync.searchRefs).toHaveBeenCalledWith('scheduler'))
  await waitFor(() => expect(screen.queryByText('glossary.md')).toBeNull())
  expect(screen.getByText('routing-flow.md')).toBeTruthy()
  // clearing the query restores the unfiltered list without another IPC call
  fireEvent.change(screen.getByRole('textbox', { name: 'search references' }), {
    target: { value: '' }
  })
  expect(await screen.findByText('glossary.md')).toBeTruthy()
})

it('clicking a reference row opens the markdown viewer', async () => {
  render(<ReferencesSettings />)
  fireEvent.click(await screen.findByRole('button', { name: 'open · glossary.md' }))
  await waitFor(() => expect(window.argus.refsync.readRef).toHaveBeenCalledWith('glossary.md'))
  expect(await screen.findByRole('dialog', { name: 'reference · glossary.md' })).toBeTruthy()
  expect(await screen.findByText('terms')).toBeTruthy()
})

it('manage and remove are icon buttons; remove confirms before calling', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
  render(<ReferencesSettings />)
  expect(await screen.findByRole('button', { name: 'manage · NAVNATIVE' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'remove · NAVNATIVE' }))
  expect(confirmSpy).toHaveBeenCalled()
  await waitFor(() => expect(window.argus.refsync.removeSpace).toHaveBeenCalledWith('NAVNATIVE'))
  confirmSpy.mockRestore()
})
