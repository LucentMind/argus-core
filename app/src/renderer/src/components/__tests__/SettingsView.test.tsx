// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SettingsView } from '../settings/SettingsView'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import { DEFAULT_PRESETS } from '../../../../shared/connectors'
import type { PacksListPayload } from '../../../../shared/packs'

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
  packs: [
    {
      id: 'navigation',
      displayName: 'Navigation',
      installedVersion: '1.0.0',
      loadedVersion: '1.0.0',
      platform: 'win-x64',
      pendingRelaunch: false,
      binaries: []
    }
  ]
}

let currentPayload: SettingsPayload

beforeEach(() => {
  currentPayload = payload()
  // SettingsStore is a lazy-started module singleton (Task 8); reset it so each
  // test's fresh <SettingsView/> mount refetches against this test's mocked payload
  // instead of reusing whatever an earlier test in this file already cached.
  settingsStore.reset()
  window.argus = {
    settings: {
      get: vi.fn(async () => currentPayload),
      patch: vi.fn(async () => currentPayload),
      probeTools: vi.fn(async () => []),
      pickPath: vi.fn(async () => null),
      reveal: vi.fn(),
      onChanged: vi.fn(() => () => {})
    },
    packs: {
      list: vi.fn(async () => packsListed),
      pickBundle: vi.fn(async () => null),
      inspect: vi.fn(),
      install: vi.fn(),
      uninstall: vi.fn(),
      relaunch: vi.fn(),
      onChanged: vi.fn(() => () => {})
    },
    agent: { authStatus: vi.fn(async () => ({ ok: true, detail: 'ready' })) },
    connectors: {
      get: vi.fn(async () => ({
        connectors: {},
        runtime: {},
        oauth: {},
        loadError: null,
        secretsAvailable: true,
        secretsLoadError: null,
        presets: DEFAULT_PRESETS
      })),
      patch: vi.fn(async () => ({
        connectors: {},
        runtime: {},
        oauth: {},
        loadError: null,
        secretsAvailable: true,
        secretsLoadError: null,
        presets: DEFAULT_PRESETS
      })),
      test: vi.fn().mockResolvedValue({ ok: true, tools: [] }),
      oauth: vi.fn().mockResolvedValue({ ok: true }),
      onChanged: vi.fn(() => () => {})
    },
    secrets: {
      set: vi.fn().mockResolvedValue(undefined),
      has: vi.fn().mockResolvedValue(false),
      delete: vi.fn().mockResolvedValue(undefined)
    },
    health: {
      list: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue(undefined),
      onResult: vi.fn(() => () => {})
    },
    sourceControl: {
      status: vi.fn().mockResolvedValue({
        installed: true,
        version: 'gh version 2.96.0 (2026-07-02)',
        authenticated: true,
        login: 'jiawiehan',
        detail: 'Logged in to github.com account jiawiehan'
      })
    }
  } as never
})

describe('SettingsView', () => {
  it('renders the rail: 8 active pages, 0 coming-soon entries', async () => {
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByRole('button', { name: /General/ })
    for (const label of [
      'General',
      'Agent',
      'Health',
      'Connectors',
      'Skills',
      'HiveMind',
      'Memory',
      'Observability'
    ])
      expect(
        (screen.getByRole('button', { name: new RegExp(label) }) as HTMLButtonElement).disabled
      ).toBe(false)
  })

  it('lists sections in the intended order and drops Analysis Tools', () => {
    render(<SettingsView onClose={() => {}} />)
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    const labels = Array.from(nav.querySelectorAll('button')).map((b) => b.textContent?.trim())
    expect(labels).toEqual([
      'General',
      'Agent',
      'Connectors',
      'HiveMind',
      'Skills',
      'Memory',
      'References',
      'Packs',
      'Health',
      'Observability'
    ])
    expect(screen.queryByText('Analysis Tools')).toBeNull()
  })

  it('falls back to General for an unrecognised initialPage', () => {
    // OnboardingProvider deep-links via `target as PageId`, so a stale 'tools'
    // target is a runtime value the type system never sees.
    render(<SettingsView onClose={() => {}} initialPage={'tools' as never} />)
    const general = screen
      .getByRole('navigation', { name: 'Settings sections' })
      .querySelector('button')
    expect(general?.className).toContain('bg-hi')
  })

  it('clicking Health renders the health page', async () => {
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByRole('button', { name: /General/ })
    fireEvent.click(screen.getByRole('button', { name: /^Health$/ }))
    expect(await screen.findByText('Health checks')).toBeTruthy()
  })

  it('clicking Connectors renders the connectors page', async () => {
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByRole('button', { name: /General/ })
    fireEvent.click(screen.getByRole('button', { name: /Connectors/ }))
    expect(await screen.findByRole('button', { name: /add connector/i })).toBeTruthy()
  })

  it('clicking Packs renders PacksSettings', async () => {
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByRole('button', { name: /General/ })
    fireEvent.click(screen.getByRole('button', { name: /^Packs$/ }))
    expect(await screen.findByText('Installed Packs')).toBeTruthy()
    expect(await screen.findByText('Navigation')).toBeTruthy()
  })

  it('Escape calls onClose', async () => {
    const onClose = vi.fn()
    render(<SettingsView onClose={onClose} />)
    await screen.findByRole('button', { name: /General/ })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows a load-error banner with an Open file action', async () => {
    currentPayload = payload({ loadError: 'Unexpected token' })
    render(<SettingsView onClose={vi.fn()} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('could not be parsed')
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }))
    expect(window.argus.settings.reveal).toHaveBeenCalledWith('settingsFile')
  })

  it('a save-failure loadError renders its own message, not the parse-failure copy', async () => {
    currentPayload = payload({ loadError: 'settings save failed: EACCES' })
    render(<SettingsView onClose={vi.fn()} />)
    const alert = await screen.findByRole('alert')
    expect(screen.queryByText(/could not be parsed/)).toBeNull()
    expect(alert.textContent).toContain('settings save failed: EACCES')
  })
})
