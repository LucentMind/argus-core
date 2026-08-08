// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { PacksSettings } from '../PacksSettings'
import { confirm } from '../../../lib/confirmStore'
import type { InstallResult, InstalledPackRow, PacksListPayload } from '../../../../../shared/packs'

vi.mock('../../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))
import {
  defaultSettings,
  type SettingsPayload,
  type ResolvedToolRow
} from '../../../../../shared/settings'

const listed: PacksListPayload = {
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
      binaries: [
        { id: 'argus-demo', displayName: 'Demo', ok: true, detail: 'C:/…/argus-demo · v22' }
      ],
      update: null
    },
    {
      id: 'code-graph',
      displayName: 'CODE-GRAPH',
      installedVersion: null, // bundled — not removable
      loadedVersion: '0.1.0',
      platform: null,
      pendingRelaunch: false,
      binaries: [],
      update: null
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

/** A complete InstalledPackRow with sensible defaults, shallow-merged with overrides. */
function row(over: Partial<InstalledPackRow> & { id: string }): InstalledPackRow {
  return {
    displayName: over.id,
    installedVersion: '1.0.0',
    loadedVersion: '1.0.0',
    platform: 'win-x64',
    pendingRelaunch: false,
    binaries: [],
    update: null,
    ...over
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
    checkUpdates: vi.fn().mockResolvedValue({}),
    applyUpdate: vi.fn().mockResolvedValue({ phase: 'idle' }),
    inspectRepo: vi.fn().mockResolvedValue({ ok: true, packs: [] }),
    installFromRepo: vi.fn().mockResolvedValue({
      ok: true,
      id: 'sample',
      version: '1.0.0',
      previousVersion: null,
      relaunchRequired: true
    }),
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
  vi.mocked(confirm).mockResolvedValue(true)
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
    expect(confirm).not.toHaveBeenCalled()
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
    vi.mocked(confirm).mockResolvedValue(false)
    render(<PacksSettings settings={settingsPayload()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install from file' }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
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
    vi.mocked(confirm).mockResolvedValue(false)
    render(<PacksSettings settings={settingsPayload()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install from file' }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
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
          binaries: [],
          update: null
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
    vi.mocked(confirm).mockResolvedValue(true)
    render(<PacksSettings settings={settingsPayload()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install from file' }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
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
    const toggle = await screen.findByRole('button', { name: 'Expand tools · navigation' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Demo tool')).toBeNull()

    fireEvent.click(toggle)
    expect(await screen.findByText('Demo tool')).toBeInTheDocument()
    expect(await screen.findByText(/found · v22/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse tools · navigation' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })

  it('shows a bare chevron, not a tool-count summary line', async () => {
    render(<PacksSettings settings={settingsPayload()} />)
    await screen.findByRole('button', { name: 'Expand tools · navigation' })
    expect(screen.queryByText('1 tool')).toBeNull()
  })

  it('groups each tool under its declaring pack only', async () => {
    const rows: ResolvedToolRow[] = [
      ...toolRows,
      { ...toolRows[0], id: 'graphify', packId: 'code-graph', displayName: 'Graphify' }
    ]
    const { container } = render(<PacksSettings settings={settingsPayload(rows)} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Expand tools · navigation' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Expand tools · code-graph' }))
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
    expect(screen.getAllByRole('button', { name: /^Expand tools · / })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Expand tools · code-graph' })).toBeNull()
  })

  it('Re-run checks re-probes every tool, including collapsed ones', async () => {
    render(<PacksSettings settings={settingsPayload()} />)
    await screen.findByRole('button', { name: 'Expand tools · navigation' })
    fireEvent.click(screen.getByRole('button', { name: 'Re-run checks' }))
    await waitFor(() => expect(window.argus.settings.probeTools).toHaveBeenCalledTimes(2))
  })

  it('offers Update on a pack with an available update', async () => {
    packs.list = vi.fn().mockResolvedValue({
      error: null,
      packs: [row({ id: 'sample', update: { phase: 'available', version: '1.1.0' } })]
    })
    render(<PacksSettings settings={settingsPayload([])} />)
    expect(await screen.findByRole('button', { name: /update · sample/i })).toBeInTheDocument()
  })

  it('shows no Update button when the pack is idle', async () => {
    packs.list = vi.fn().mockResolvedValue({
      error: null,
      packs: [row({ id: 'sample', update: { phase: 'idle' } })]
    })
    render(<PacksSettings settings={settingsPayload([])} />)
    await screen.findByText('sample')
    expect(screen.queryByRole('button', { name: /update · sample/i })).not.toBeInTheDocument()
  })

  it('shows a pack-appropriate sentence for an idle pack instead of no feedback at all (Fix 4)', async () => {
    // Before the fix, an idle pack's status line was suppressed entirely — a successful "Check
    // for pack updates" that finds nothing looked identical to a broken button. The suppression
    // itself existed for a real reason: `describeUpdate`'s idle sentence is the Core-app "Argus
    // is up to date", which must never appear on a pack row.
    packs.list = vi.fn().mockResolvedValue({
      error: null,
      packs: [row({ id: 'sample', update: { phase: 'idle' } })]
    })
    render(<PacksSettings settings={settingsPayload([])} />)
    expect(await screen.findByText(/no update available/i)).toBeInTheDocument()
    expect(screen.queryByText(/argus is up to date/i)).not.toBeInTheDocument()
  })

  /**
   * The page checks on arrival (user-directed, 2026-08-08) — as a button at the bottom of the
   * page, "update available" only ever appeared for a user who already suspected there was one.
   */
  it('checks for pack updates on mount, and re-lists with the result', async () => {
    render(<PacksSettings settings={settingsPayload([])} />)
    await waitFor(() => expect(packs.checkUpdates).toHaveBeenCalledOnce())
    // Not just the call: the check is worthless unless its result is pulled back into the list.
    await waitFor(() => expect(packs.list.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('Check for updates calls through', async () => {
    render(<PacksSettings settings={settingsPayload([])} />)
    const btn = await screen.findByRole('button', { name: /check for pack updates/i })
    // Disabled while the mount check is still in flight, so wait it out rather than clicking a
    // dead button and asserting on the mount call by accident.
    await waitFor(() => expect(btn).not.toBeDisabled())
    fireEvent.click(btn)
    await waitFor(() => expect(packs.checkUpdates).toHaveBeenCalledTimes(2))
  })

  it('renders a failure with the shared wording, not an invented sentence', async () => {
    packs.list = vi.fn().mockResolvedValue({
      error: null,
      packs: [
        row({
          id: 'sample',
          update: { phase: 'error', message: 'origin mismatch', at: 1, code: 'origin-pin' }
        })
      ]
    })
    render(<PacksSettings settings={settingsPayload([])} />)
    expect(await screen.findByText(/update failed: origin mismatch/i)).toBeInTheDocument()
  })

  it('tells the user to download manually when the origin pin refused', async () => {
    packs.list = vi.fn().mockResolvedValue({
      error: null,
      packs: [
        row({
          id: 'sample',
          update: { phase: 'error', message: 'origin mismatch', at: 1, code: 'origin-pin' }
        })
      ]
    })
    render(<PacksSettings settings={settingsPayload([])} />)
    expect(await screen.findByText(/download it manually/i)).toBeInTheDocument()
  })

  it('tells the user to fix their GitHub CLI auth when a check fails with code gh', async () => {
    packs.list = vi.fn().mockResolvedValue({
      error: null,
      packs: [
        row({
          id: 'sample',
          update: {
            phase: 'error',
            code: 'gh',
            message: 'the GitHub CLI is not authenticated',
            at: 1
          }
        })
      ]
    })
    render(<PacksSettings settings={settingsPayload([])} />)
    expect(await screen.findByText(/GitHub CLI/)).toBeInTheDocument()
    expect(screen.getByText(/Settings → Health/)).toBeInTheDocument()
  })

  it('prompts for relaunch after a successful applyUpdate', async () => {
    packs.list = vi.fn().mockResolvedValue({
      error: null,
      packs: [row({ id: 'sample', update: { phase: 'available', version: '1.1.0' } })]
    })
    packs.applyUpdate = vi.fn().mockResolvedValue({ phase: 'ready', version: '1.1.0' })
    render(<PacksSettings settings={settingsPayload([])} />)
    fireEvent.click(await screen.findByRole('button', { name: /update · sample/i }))
    await waitFor(() => expect(packs.applyUpdate).toHaveBeenCalledWith('sample'))
    expect(await screen.findByRole('button', { name: 'Relaunch now' })).toBeInTheDocument()
  })

  it('does not prompt for relaunch when applyUpdate resolves to an error status', async () => {
    packs.list = vi.fn().mockResolvedValue({
      error: null,
      packs: [row({ id: 'sample', update: { phase: 'available', version: '1.1.0' } })]
    })
    packs.applyUpdate = vi.fn().mockResolvedValue({
      phase: 'error',
      message: 'origin mismatch',
      at: 1,
      code: 'origin-pin'
    })
    render(<PacksSettings settings={settingsPayload([])} />)
    const btn = await screen.findByRole('button', { name: /update · sample/i })
    fireEvent.click(btn)
    await waitFor(() => expect(packs.applyUpdate).toHaveBeenCalledWith('sample'))
    // Wait for applyUpdate's whole chain (including its refresh) to settle before asserting an
    // absence. Keyed on the button re-enabling — i.e. `busy` cleared in the `finally` — rather
    // than on a `packs.list` call count, which the mount-time update check also contributes to.
    await waitFor(() => expect(btn).not.toBeDisabled())
    expect(screen.queryByRole('button', { name: 'Relaunch now' })).not.toBeInTheDocument()
  })

  it('surfaces an Update failure through the alert, not a silent re-enable', async () => {
    packs.list = vi.fn().mockResolvedValue({
      error: null,
      packs: [row({ id: 'sample', update: { phase: 'available', version: '1.1.0' } })]
    })
    packs.applyUpdate = vi.fn().mockRejectedValue(new Error('network unreachable'))
    render(<PacksSettings settings={settingsPayload([])} />)
    fireEvent.click(await screen.findByRole('button', { name: /update · sample/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('network unreachable')
  })

  it('surfaces a Check for pack updates failure through the alert', async () => {
    packs.checkUpdates = vi.fn().mockRejectedValue(new Error('offline'))
    render(<PacksSettings settings={settingsPayload([])} />)
    fireEvent.click(await screen.findByRole('button', { name: /check for pack updates/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('offline')
  })

  it('clears a stale install error when checkUpdates succeeds', async () => {
    packs.install = vi.fn().mockResolvedValue({
      ok: false,
      code: 'checksum',
      error: 'bundle corrupted'
    })
    packs.checkUpdates = vi.fn().mockResolvedValue({})

    render(<PacksSettings settings={settingsPayload()} />)

    // Trigger install failure
    fireEvent.click(await screen.findByRole('button', { name: 'Install from file' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/bundle failed verification/i)

    // Trigger successful checkUpdates — should clear the stale error
    fireEvent.click(screen.getByRole('button', { name: /check for pack updates/i }))
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  it('finds the packs a repo publishes and installs the chosen one', async () => {
    const user = userEvent.setup()
    packs.list = vi.fn().mockResolvedValue({ error: null, packs: [] })
    packs.inspectRepo = vi.fn().mockResolvedValue({
      ok: true,
      packs: [
        { id: 'sample-bridge-playground', version: '0.1.0', tag: 'v0.1.0', installable: true },
        {
          id: 'sample-external-app',
          version: '0.1.0',
          tag: 'v0.1.0',
          installable: false,
          reason: "It isn't compatible with this version of Argus."
        }
      ]
    })
    packs.installFromRepo = vi.fn().mockResolvedValue({
      ok: true,
      id: 'sample-bridge-playground',
      version: '0.1.0',
      previousVersion: null,
      relaunchRequired: true
    })

    render(<PacksSettings settings={settingsPayload([])} />)

    await user.click(await screen.findByRole('button', { name: 'Install from GitHub' }))
    await user.type(screen.getByLabelText('GitHub repository'), 'LucentMind/demo_pack')
    await user.click(screen.getByRole('button', { name: 'Find packs' }))

    expect(await screen.findByText('sample-bridge-playground')).toBeInTheDocument()
    // An incompatible pack is SHOWN with its reason, never silently omitted.
    expect(screen.getByText(/isn't compatible/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Install sample-external-app' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Install sample-bridge-playground' }))
    expect(packs.installFromRepo).toHaveBeenCalledWith(
      'LucentMind/demo_pack',
      'sample-bridge-playground'
    )
    expect(await screen.findByText(/Relaunch Argus/)).toBeInTheDocument()
  })

  it('shows the error a failed repo lookup returns', async () => {
    const user = userEvent.setup()
    packs.list = vi.fn().mockResolvedValue({ error: null, packs: [] })
    packs.inspectRepo = vi.fn().mockResolvedValue({
      ok: false,
      error: 'the GitHub CLI is not authenticated'
    })

    render(<PacksSettings settings={settingsPayload([])} />)

    await user.click(await screen.findByRole('button', { name: 'Install from GitHub' }))
    await user.type(screen.getByLabelText('GitHub repository'), 'acme/private-pack')
    await user.click(screen.getByRole('button', { name: 'Find packs' }))

    expect(await screen.findByText(/not authenticated/)).toBeInTheDocument()
  })

  it('drops a previous repo’s packs when the field is edited', async () => {
    const user = userEvent.setup()
    packs.list = vi.fn().mockResolvedValue({ error: null, packs: [] })
    packs.inspectRepo = vi.fn().mockResolvedValue({
      ok: true,
      packs: [
        { id: 'sample-bridge-playground', version: '0.1.0', tag: 'v0.1.0', installable: true }
      ]
    })

    render(<PacksSettings settings={settingsPayload([])} />)

    await user.click(await screen.findByRole('button', { name: 'Install from GitHub' }))
    await user.type(screen.getByLabelText('GitHub repository'), 'owner/repoA')
    await user.click(screen.getByRole('button', { name: 'Find packs' }))

    expect(await screen.findByText('sample-bridge-playground')).toBeInTheDocument()

    await user.type(screen.getByLabelText('GitHub repository'), 'b')

    expect(screen.queryByText('sample-bridge-playground')).not.toBeInTheDocument()
  })

  it('shows the relaunch prompt from main alone, with no install run on this mount', async () => {
    // The durable half. Installing, navigating away and coming back remounts this component with
    // no memory of the install — before, the prompt vanished while the app still ran stale packs.
    packs.list = vi.fn().mockResolvedValue({ ...listed, relaunchRequired: true })
    render(<PacksSettings settings={settingsPayload()} />)
    expect(await screen.findByText(/Relaunch Argus/)).toBeInTheDocument()
    expect(packs.install).not.toHaveBeenCalled()
    expect(packs.uninstall).not.toHaveBeenCalled()
  })

  it('survives a remount after an install, because main still reports it', async () => {
    const { unmount } = render(<PacksSettings settings={settingsPayload()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install from file' }))
    expect(await screen.findByText(/Relaunch Argus/)).toBeInTheDocument()

    // main recorded the write; the fresh mount has only that to go on.
    packs.list = vi.fn().mockResolvedValue({ ...listed, relaunchRequired: true })
    unmount()
    render(<PacksSettings settings={settingsPayload()} />)
    expect(await screen.findByText(/Relaunch Argus/)).toBeInTheDocument()
  })

  it('keeps Relaunch clickable while a pack operation is still in flight', async () => {
    // `busy` gating this button meant an install that never settled left the one control that
    // fixes a stale-pack state permanently disabled.
    let release!: (r: InstallResult) => void
    packs.list = vi.fn().mockResolvedValue({ ...listed, relaunchRequired: true })
    packs.installFromRepo = vi.fn(
      () =>
        new Promise<InstallResult>((resolve) => {
          release = resolve
        })
    )
    packs.inspectRepo = vi.fn().mockResolvedValue({
      ok: true,
      packs: [{ id: 'sample', version: '1.0.0', tag: 'v1.0.0', installable: true }]
    })
    const user = userEvent.setup()
    render(<PacksSettings settings={settingsPayload()} />)

    await user.click(await screen.findByRole('button', { name: 'Install from GitHub' }))
    await user.type(screen.getByLabelText('GitHub repository'), 'owner/repo')
    await user.click(screen.getByRole('button', { name: 'Find packs' }))
    await user.click(await screen.findByRole('button', { name: 'Install sample' }))
    await waitFor(() => expect(packs.installFromRepo).toHaveBeenCalled())

    const relaunch = screen.getByRole('button', { name: 'Relaunch now' })
    expect(relaunch).toBeEnabled()
    fireEvent.click(relaunch)
    expect(packs.relaunch).toHaveBeenCalled()
    release({
      ok: true,
      id: 'sample',
      version: '1.0.0',
      previousVersion: null,
      relaunchRequired: true
    })
  })

  it('installs against the repo the listed packs came from, not whatever is in the field', async () => {
    const user = userEvent.setup()
    packs.list = vi.fn().mockResolvedValue({ error: null, packs: [] })
    packs.inspectRepo = vi.fn().mockResolvedValue({
      ok: true,
      packs: [
        { id: 'sample-bridge-playground', version: '0.1.0', tag: 'v0.1.0', installable: true }
      ]
    })
    const installFromRepo = vi.fn<(ref: string, packId: string) => Promise<InstallResult>>(
      async () => ({
        ok: true,
        id: 'sample-bridge-playground',
        version: '0.1.0',
        previousVersion: null,
        relaunchRequired: true
      })
    )
    packs.installFromRepo = installFromRepo

    render(<PacksSettings settings={settingsPayload([])} />)

    await user.click(await screen.findByRole('button', { name: 'Install from GitHub' }))
    await user.type(screen.getByLabelText('GitHub repository'), 'owner/repoA')
    await user.click(screen.getByRole('button', { name: 'Find packs' }))
    expect(await screen.findByText('sample-bridge-playground')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Install sample-bridge-playground' }))

    expect(installFromRepo.mock.calls[0][0]).toBe('owner/repoA')
  })
})
