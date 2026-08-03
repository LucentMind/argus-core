// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SourcesPage } from '../SourcesPage'
import { referenceSyncStore } from '../../../lib/referenceSyncStore'
import { connectorsStore } from '../../../lib/connectorsStore'
import { defaultSettings, type SettingsPayload } from '../../../../../shared/settings'
import type { PacksListPayload } from '../../../../../shared/packs'
import type { RefSyncPayload } from '../../../../../shared/referenceSync'
import type { ConnectorsPayload } from '../../../../../shared/connectors'

vi.mock('../../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

// SettingsView.test.tsx's payload() (lines 15-51)
function payload(overrides: Partial<SettingsPayload> = {}): SettingsPayload {
  return {
    settings: defaultSettings(),
    resolvedTools: [
      {
        id: 'sample-parse',
        packId: 'sample-pack',
        displayName: 'sample-parse binary',
        description: 'Binary log decoder',
        kind: 'exe',
        envVar: 'ARGUS_PARSE_BIN',
        settingsKey: 'parseBin',
        settingsValue: '',
        value: null,
        source: 'default'
      }
    ],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null,
    ...overrides
  }
}

const packsListed: PacksListPayload = {
  error: null,
  relaunchRequired: false,
  packs: [
    {
      id: 'navigation',
      displayName: 'Navigation',
      installedVersion: '1.0.0',
      loadedVersion: '1.0.0',
      platform: 'win-x64',
      pendingRelaunch: false,
      binaries: [],
      update: null
    }
  ]
}

// refsync/connectors fixtures matching the ConfluenceSpaces harness
const refPayload: RefSyncPayload = {
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
      stale: true,
      author: null
    }
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
    settings: {
      get: vi.fn(async () => payload()),
      patch: vi.fn(async () => payload()),
      probeTools: vi.fn(async () => []),
      pickPath: vi.fn(async () => null),
      onChanged: vi.fn(() => () => undefined)
    },
    packs: {
      list: vi.fn(async () => packsListed),
      pickBundle: vi.fn(async () => null),
      inspect: vi.fn(),
      install: vi.fn(),
      uninstall: vi.fn(),
      relaunch: vi.fn(),
      onChanged: vi.fn(() => () => undefined)
    },
    graph: { install: vi.fn(async () => ({ ok: true, log: 'installed' })) },
    refsync: {
      get: vi.fn(async () => refPayload),
      onChanged: vi.fn(() => () => undefined),
      onProgress: vi.fn(() => () => undefined),
      sync: vi.fn(async () => ({ ok: false, code: 'auth', message: 'PAT rejected' })),
      removeSpace: vi.fn(async () => refPayload),
      searchRefs: vi.fn(async () => []),
      readRef: vi.fn(async () => ({ file: 'glossary.md', content: '# Glossary\n' }))
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

describe('SourcesPage', () => {
  it('renders the installed packs', async () => {
    render(<SourcesPage settings={payload()} />)
    expect(await screen.findByText('Installed Packs')).toBeInTheDocument()
  })

  /**
   * Confluence moved to Team (2026-08-01, user-directed): a synced space is a shared upstream,
   * the same kind of thing as the HiveMind repo, so the two are paired there instead. This page
   * is pack machinery now. Asserted as an ABSENCE so a future re-import has to be deliberate —
   * the two pages would otherwise both grow a Confluence section and neither would be wrong.
   */
  it('no longer carries Confluence sync', async () => {
    render(<SourcesPage settings={payload()} />)
    await screen.findByText('Installed Packs')
    expect(screen.queryByText('Confluence')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add Confluence space' })).toBeNull()
  })
})
