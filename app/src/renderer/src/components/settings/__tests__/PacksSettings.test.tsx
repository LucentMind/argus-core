// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { PacksSettings } from '../PacksSettings'
import type { PacksListPayload } from '../../../../../shared/packs'
import {
  defaultSettings,
  type SettingsPayload,
  type ResolvedToolRow
} from '../../../../../shared/settings'

const listed: PacksListPayload = {
  error: null,
  packs: [
    {
      id: 'navigation',
      displayName: 'Navigation',
      installedVersion: '1.0.0',
      loadedVersion: '1.0.0',
      platform: 'win-x64',
      pendingRelaunch: false,
      binaries: [
        { id: 'argus-demo', displayName: 'Demo', ok: true, detail: 'C:/…/argus-demo · v22' }
      ]
    },
    {
      id: 'code-graph',
      displayName: 'CODE-GRAPH',
      installedVersion: null, // bundled — not removable
      loadedVersion: '0.1.0',
      platform: null,
      pendingRelaunch: false,
      binaries: []
    }
  ]
}

const toolRows: ResolvedToolRow[] = [
  {
    id: 'argus-demo',
    packId: 'navigation',
    displayName: 'Demo tool',
    description: 'demo',
    kind: 'exe',
    envVar: null,
    settingsKey: 'demoBin',
    settingsValue: '',
    value: null,
    source: 'default'
  }
]

function settingsPayload(rows: ResolvedToolRow[] = toolRows): SettingsPayload {
  return {
    settings: defaultSettings(),
    resolvedTools: rows,
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
}

function mockPacks(
  over: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}
): Record<string, ReturnType<typeof vi.fn>> {
  return {
    list: vi.fn().mockResolvedValue(listed),
    pickBundle: vi.fn().mockResolvedValue('C:/dl/navigation-2.0.0-win-x64.zip'),
    inspect: vi.fn().mockResolvedValue({
      id: 'navigation',
      version: '2.0.0',
      platform: 'win-x64',
      apiCompatible: true,
      platformCompatible: true
    }),
    install: vi.fn().mockResolvedValue({
      ok: true,
      id: 'navigation',
      version: '2.0.0',
      previousVersion: '1.0.0',
      relaunchRequired: true
    }),
    uninstall: vi.fn().mockResolvedValue({ ok: true }),
    relaunch: vi.fn().mockResolvedValue(undefined),
    onChanged: vi.fn().mockReturnValue(() => {}),
    ...over
  }
}

let packs: Record<string, ReturnType<typeof vi.fn>>
beforeEach(() => {
  packs = mockPacks()
  ;(window as unknown as { argus: unknown }).argus = {
    packs,
    settings: {
      get: vi.fn(async () => settingsPayload()),
      patch: vi.fn(async () => settingsPayload()),
      probeTools: vi.fn(async () => [
        { id: 'argus-demo', ok: true, chip: 'found · v22', detail: 'C:/…/argus-demo · v22' }
      ]),
      pickPath: vi.fn(async () => 'C:\\new'),
      onChanged: vi.fn(() => () => {})
    },
    graph: { install: vi.fn(async () => ({ ok: true, log: 'installed' })) }
  }
  window.confirm = vi.fn(() => true)
})

describe('PacksSettings', () => {
  it('lists installed packs and shows Uninstall only for user-installed ones', async () => {
    render(<PacksSettings settings={settingsPayload()} />)
    expect(await screen.findByText('Navigation')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Uninstall · navigation' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Uninstall · code-graph' })).not.toBeInTheDocument()
  })

  it('install flow: pick → inspect → install → relaunch prompt (upgrade never prompts)', async () => {
    render(<PacksSettings settings={settingsPayload()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install from file' }))
    await waitFor(() =>
      expect(packs.install).toHaveBeenCalledWith('C:/dl/navigation-2.0.0-win-x64.zip')
    )
    // installed 1.0.0, picked 2.0.0 — a clean upgrade must proceed without a confirm
    expect(window.confirm).not.toHaveBeenCalled()
    const relaunch = await screen.findByRole('button', { name: 'Relaunch now' })
    fireEvent.click(relaunch)
    expect(packs.relaunch).toHaveBeenCalled()
  })

  it('rejects an incompatible-platform bundle with an error and does not install', async () => {
    packs.inspect = vi.fn().mockResolvedValue({
      id: 'navigation',
      version: '2.0.0',
      platform: 'mac-arm64',
      apiCompatible: true,
      platformCompatible: false
    })
    render(<PacksSettings settings={settingsPayload()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install from file' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/mac-arm64|does not match/i)
    expect(packs.install).not.toHaveBeenCalled()
  })

  it('warns on a downgrade/re-install and skips when the user cancels', async () => {
    packs.inspect = vi.fn().mockResolvedValue({
      id: 'navigation',
      version: '0.9.0',
      platform: 'win-x64',
      apiCompatible: true,
      platformCompatible: true
    })
    window.confirm = vi.fn(() => false)
    render(<PacksSettings settings={settingsPayload()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install from file' }))
    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(packs.install).not.toHaveBeenCalled()
  })

  it('warns on an equal-version re-install and skips when the user cancels', async () => {
    packs.inspect = vi.fn().mockResolvedValue({
      id: 'navigation',
      version: '1.0.0',
      platform: 'win-x64',
      apiCompatible: true,
      platformCompatible: true
    })
    window.confirm = vi.fn(() => false)
    render(<PacksSettings settings={settingsPayload()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install from file' }))
    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(packs.install).not.toHaveBeenCalled()
  })

  it('does not crash on non-semver versions: falls back to warn-on-any-reinstall', async () => {
    // Pack manifests allow any non-empty version string (e.g. "2024.1"), which
    // semver.lte() would throw on — the gate must fall back to a plain confirm.
    packs.list = vi.fn().mockResolvedValue({
      error: null,
      packs: [
        {
          id: 'navigation',
          displayName: 'Navigation',
          installedVersion: '2024.1',
          loadedVersion: '2024.1',
          platform: 'win-x64',
          pendingRelaunch: false,
          binaries: []
        }
      ]
    })
    packs.inspect = vi.fn().mockResolvedValue({
      id: 'navigation',
      version: '2024.2',
      platform: 'win-x64',
      apiCompatible: true,
      platformCompatible: true
    })
    window.confirm = vi.fn(() => true)
    render(<PacksSettings settings={settingsPayload()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install from file' }))
    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    await waitFor(() =>
      expect(packs.install).toHaveBeenCalledWith('C:/dl/navigation-2.0.0-win-x64.zip')
    )
  })

  it('uninstall confirms then calls uninstall and prompts relaunch', async () => {
    render(<PacksSettings settings={settingsPayload()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall · navigation' }))
    await waitFor(() => expect(packs.uninstall).toHaveBeenCalledWith('navigation'))
    expect(await screen.findByRole('button', { name: 'Relaunch now' })).toBeInTheDocument()
  })

  it('keeps a pack’s analysis tools collapsed until the disclosure is opened', async () => {
    render(<PacksSettings settings={settingsPayload()} />)
    const toggle = await screen.findByRole('button', { name: 'Show tools · navigation' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Demo tool')).toBeNull()

    fireEvent.click(toggle)
    expect(await screen.findByText('Demo tool')).toBeInTheDocument()
    expect(await screen.findByText(/found · v22/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide tools · navigation' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })

  it('summarises the tool count on the collapsed disclosure', async () => {
    render(<PacksSettings settings={settingsPayload()} />)
    expect(await screen.findByText('1 tool')).toBeInTheDocument()
  })

  it('groups each tool under its declaring pack only', async () => {
    const rows: ResolvedToolRow[] = [
      ...toolRows,
      { ...toolRows[0], id: 'graphify', packId: 'code-graph', displayName: 'Graphify' }
    ]
    const { container } = render(<PacksSettings settings={settingsPayload(rows)} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show tools · navigation' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Show tools · code-graph' }))
    await screen.findByText('Demo tool')

    const navGroup = container.querySelector('[data-pack-tools="navigation"]')
    const cgGroup = container.querySelector('[data-pack-tools="code-graph"]')
    expect(navGroup).toHaveTextContent('Demo tool')
    expect(navGroup).not.toHaveTextContent('Graphify')
    expect(cgGroup).toHaveTextContent('Graphify')
    expect(cgGroup).not.toHaveTextContent('Demo tool')
  })

  it('renders no tool disclosure for a pack that declares none', async () => {
    render(<PacksSettings settings={settingsPayload()} />)
    await screen.findByText('CODE-GRAPH')
    // only `navigation` owns a tool in the default fixture
    expect(screen.getAllByRole('button', { name: /^Show tools · / })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Show tools · code-graph' })).toBeNull()
  })

  it('Re-run checks re-probes every tool, including collapsed ones', async () => {
    render(<PacksSettings settings={settingsPayload()} />)
    await screen.findByRole('button', { name: 'Show tools · navigation' })
    fireEvent.click(screen.getByRole('button', { name: 'Re-run checks' }))
    await waitFor(() => expect(window.argus.settings.probeTools).toHaveBeenCalledTimes(2))
  })
})
