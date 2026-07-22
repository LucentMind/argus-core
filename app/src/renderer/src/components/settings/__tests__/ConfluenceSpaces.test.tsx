// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { it, expect, vi, beforeEach, afterEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { ConfluenceSpaces } from '../ConfluenceSpaces'
import { referenceSyncStore } from '../../../lib/referenceSyncStore'
import { connectorsStore } from '../../../lib/connectorsStore'
import { confirm } from '../../../lib/confirmStore'
import { __resetEscapeLayersForTest } from '../../../lib/escapeLayer'
import type { RefSyncPayload, SyncReport } from '../../../../../shared/referenceSync'
import type { ConnectorsPayload } from '../../../../../shared/connectors'

vi.mock('../../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

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
      config: { url: 'https://mcp.atlassian.com/v1/mcp/authv2', transport: 'http', oauth: true }
    }
  },
  runtime: {},
  oauth: { rovo: 'authorized' },
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
    },
    openExternal: vi.fn()
  }
})

afterEach(() => __resetEscapeLayersForTest())

it('renders space cards with staleness and reference statuses', async () => {
  render(<ConfluenceSpaces />)
  expect(await screen.findByText('Nav Native')).toBeTruthy()
  expect(screen.getAllByText('stale').length).toBeGreaterThan(0)
})

it('Sync now surfaces a REST auth failure inline', async () => {
  render(<ConfluenceSpaces />)
  fireEvent.click(await screen.findByRole('button', { name: 'sync · NAVNATIVE' }))
  await waitFor(() => expect(window.argus.refsync.sync).toHaveBeenCalledWith('NAVNATIVE'))
  expect(await screen.findByText(/PAT rejected/)).toBeTruthy()
})

it('an OAuth-only rovo connector that is not yet authorized disables Sync with an Authorize-connector warning', async () => {
  ;(window.argus.connectors.get as ReturnType<typeof vi.fn>).mockResolvedValue({
    ...connectorsPayload,
    oauth: {}
  })
  render(<ConfluenceSpaces />)
  expect(
    await screen.findByText(
      'Authorize the Atlassian connector (Settings → Connectors) before syncing.'
    )
  ).toBeTruthy()
  const syncBtn = (await screen.findByRole('button', {
    name: 'sync · NAVNATIVE'
  })) as HTMLButtonElement
  expect(syncBtn.disabled).toBe(true)
})

it('no rovo connector configured shows a distinct warning and disables Sync', async () => {
  ;(window.argus.connectors.get as ReturnType<typeof vi.fn>).mockResolvedValue({
    ...connectorsPayload,
    connectors: {},
    oauth: {}
  })
  render(<ConfluenceSpaces />)
  expect(await screen.findByText(/No Atlassian connector configured/)).toBeTruthy()
  const syncBtn = (await screen.findByRole('button', {
    name: 'sync · NAVNATIVE'
  })) as HTMLButtonElement
  expect(syncBtn.disabled).toBe(true)
})

it('a REST auth error on the connector reports an authorization problem, not a stale API token', async () => {
  ;(window.argus.connectors.get as ReturnType<typeof vi.fn>).mockResolvedValue({
    ...connectorsPayload,
    rest: { rovo: 'token expired' }
  })
  render(<ConfluenceSpaces />)
  expect(await screen.findByText('Atlassian authorization problem: token expired')).toBeTruthy()
})

it('shows the broken-config banner from loadError', async () => {
  ;(window.argus.refsync.get as ReturnType<typeof vi.fn>).mockResolvedValue({
    ...payload,
    loadError: 'Unexpected token'
  })
  render(<ConfluenceSpaces />)
  expect(await screen.findByRole('alert')).toBeTruthy()
})

it('manage and remove are icon buttons; remove confirms before calling', async () => {
  vi.mocked(confirm).mockResolvedValue(true)
  render(<ConfluenceSpaces />)
  expect(await screen.findByRole('button', { name: 'manage · NAVNATIVE' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'remove · NAVNATIVE' }))
  expect(confirm).toHaveBeenCalled()
  await waitFor(() => expect(window.argus.refsync.removeSpace).toHaveBeenCalledWith('NAVNATIVE'))
})

const syncReport: SyncReport = {
  syncId: 'sync-1',
  spaceKey: 'NAVNATIVE',
  selectedCount: 2,
  drafts: [],
  unrouted: [],
  conflicts: [],
  failures: [],
  vanished: []
}

it('a successful sync opens the sync report modal with a single close control', async () => {
  ;(window.argus.refsync.sync as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    value: syncReport
  })
  render(<ConfluenceSpaces />)
  fireEvent.click(await screen.findByRole('button', { name: 'sync · NAVNATIVE' }))
  expect(await screen.findByRole('dialog', { name: 'sync report · NAVNATIVE' })).toBeTruthy()
  // ModalShell's own X is labelled "Close" too — assert there's exactly one,
  // i.e. SyncReportView's inline Close button did not also render.
  expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1)
})

it('closes the sync report modal on Escape', async () => {
  ;(window.argus.refsync.sync as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    value: syncReport
  })
  render(<ConfluenceSpaces />)
  fireEvent.click(await screen.findByRole('button', { name: 'sync · NAVNATIVE' }))
  expect(await screen.findByRole('dialog', { name: 'sync report · NAVNATIVE' })).toBeTruthy()
  await userEvent.keyboard('{Escape}')
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'sync report · NAVNATIVE' })).toBeNull()
  )
})
