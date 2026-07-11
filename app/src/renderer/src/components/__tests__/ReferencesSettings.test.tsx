// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { it, expect, vi, beforeEach } from 'vitest'
import { ReferencesSettings } from '../settings/ReferencesSettings'
import { referenceSyncStore } from '../../lib/referenceSyncStore'
import type { RefSyncPayload } from '../../../../shared/referenceSync'

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

beforeEach(() => {
  referenceSyncStore.reset()
  ;(window as unknown as { argus: unknown }).argus = {
    refsync: {
      get: vi.fn(async () => payload),
      onChanged: vi.fn(() => () => undefined),
      onProgress: vi.fn(() => () => undefined),
      sync: vi.fn(async () => ({ ok: false, code: 'auth', message: 'PAT rejected' })),
      removeSpace: vi.fn(async () => payload)
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
