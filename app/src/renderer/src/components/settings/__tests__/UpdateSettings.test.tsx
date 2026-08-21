// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { UpdateSettings } from '../UpdateSettings'
import { updateStore } from '../../../lib/updateStore'
import { settingsStore } from '../../../lib/settingsStore'
import type { CoreUpdatePayload, UpdateChannel } from '../../../../../shared/updates'
import type { CurrencyPayload } from '../../../../../shared/currency'
import { defaultSettings } from '../../../../../shared/settings'
import type { SettingsPayload } from '../../../../../shared/settings'

const idle: CoreUpdatePayload = {
  currentVersion: '1.0.8',
  status: { phase: 'idle' },
  channel: 'stable'
}

const idleCurrency: CurrencyPayload = { auto: true, lastSurveyAt: null, blocked: [], busy: false }

function settingsPayloadFor(channel: UpdateChannel, auto: boolean): SettingsPayload {
  return {
    settings: { ...defaultSettings(), updates: { channel, auto } },
    resolvedTools: [],
    dataRoot: { path: 'C:/tmp/argus', fromEnv: false },
    loadError: null
  }
}

function stubApi(
  over: Partial<Record<string, unknown>> = {},
  devToolsUnlock: () => Promise<{ devTools: boolean }> = vi.fn(async () => ({ devTools: false })),
  settings: SettingsPayload = settingsPayloadFor('stable', true),
  currency: CurrencyPayload = idleCurrency
): void {
  ;(window as unknown as { argus: unknown }).argus = {
    update: {
      status: vi.fn(async () => idle),
      check: vi.fn(async () => idle),
      download: vi.fn(async () => idle),
      restart: vi.fn(async () => idle),
      onChanged: vi.fn(() => () => {}),
      ...over
    },
    devTools: { unlock: devToolsUnlock },
    settings: {
      get: vi.fn(async () => settings),
      patch: vi.fn(async () => settings),
      onChanged: vi.fn(() => () => {})
    },
    currency: {
      get: vi.fn(async () => currency),
      surveyNow: vi.fn(async () => {}),
      onChanged: vi.fn(() => () => {})
    }
  }
}

beforeEach(() => {
  updateStore.clearForTests()
  // settingsStore is a module-level singleton (see RoutinesPage.test.tsx precedent): without a
  // reset here, the SECOND test onward would see the FIRST test's already-fetched payload
  // instead of this test's `stubApi()` settings, since `start()` only fetches once.
  settingsStore.reset()
  stubApi()
})

// Several tests below spy on settingsStore.patch with vi.spyOn; without a restore here it leaks
// into every later test in this file (no restoreMocks in vitest.config.ts, and no other
// afterEach in this file to catch it).
afterEach(() => vi.restoreAllMocks())

describe('UpdateSettings', () => {
  it('shows the running version once the store has loaded', async () => {
    render(<UpdateSettings />)
    expect(await screen.findByText('1.0.8')).toBeInTheDocument()
  })

  it('offers a download only when an update is available', async () => {
    stubApi({
      status: vi.fn(async () => ({
        currentVersion: '1.0.8',
        status: { phase: 'available', version: '1.1.0' }
      }))
    })
    render(<UpdateSettings />)
    expect(await screen.findByRole('button', { name: /download 1\.1\.0/i })).toBeInTheDocument()
  })

  it('checking on demand calls through and renders the result', async () => {
    const check = vi.fn(async () => ({
      currentVersion: '1.0.8',
      status: { phase: 'available' as const, version: '1.1.0' }
    }))
    stubApi({ check })
    render(<UpdateSettings />)
    await userEvent.click(await screen.findByRole('button', { name: /check for updates/i }))
    expect(check).toHaveBeenCalledOnce()
    expect(await screen.findByRole('button', { name: /download 1\.1\.0/i })).toBeInTheDocument()
  })

  it('offers a restart once bytes are staged', async () => {
    const restart = vi.fn(async () => idle)
    stubApi({
      status: vi.fn(async () => ({
        currentVersion: '1.0.8',
        status: { phase: 'ready', version: '1.1.0' }
      })),
      restart
    })
    render(<UpdateSettings />)
    await userEvent.click(await screen.findByRole('button', { name: /restart/i }))
    expect(restart).toHaveBeenCalledOnce()
  })

  it('renders an unpackaged build as an explanation, not an error', async () => {
    stubApi({
      status: vi.fn(async () => ({
        currentVersion: '1.0.8',
        status: { phase: 'unsupported', reason: 'Updates are only available in a packaged build' }
      }))
    })
    render(<UpdateSettings />)
    expect(await screen.findByText(/only available in a packaged build/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /check for updates/i })).not.toBeInTheDocument()
  })

  it('shows a failed manual check', async () => {
    stubApi({
      status: vi.fn(async () => ({
        currentVersion: '1.0.8',
        status: { phase: 'error', message: 'offline', at: 1 }
      }))
    })
    render(<UpdateSettings />)
    expect(await screen.findByText(/offline/)).toBeInTheDocument()
  })

  it('does not say "Check failed" for an error that came from a failed download', async () => {
    // Regression: the error phase is also produced by download() (see coreUpdater.ts), so its
    // wording must stay neutral about which step failed.
    stubApi({
      status: vi.fn(async () => ({
        currentVersion: '1.0.8',
        status: { phase: 'error', message: 'disk full', at: 1 }
      }))
    })
    render(<UpdateSettings />)
    expect(await screen.findByText(/disk full/)).toBeInTheDocument()
    expect(screen.queryByText(/check failed/i)).not.toBeInTheDocument()
  })

  it('shows a checking description, not a stale "up to date", while a check is in flight', async () => {
    stubApi({
      status: vi.fn(async () => ({
        currentVersion: '1.0.8',
        status: { phase: 'checking' }
      }))
    })
    render(<UpdateSettings />)
    expect(await screen.findByText(/checking for updates/i)).toBeInTheDocument()
    // Narrowed to the exact idle sentence (Task 13 added a "Keep everything up to date" toggle
    // row that is always on screen, so the old broad /up to date/i now also matches that label).
    expect(screen.queryByText(/argus is up to date/i)).not.toBeInTheDocument()
  })

  it('clicking the version 6 times unlocks dev tools and asks for a restart', async () => {
    const unlock = vi.fn(async () => ({ devTools: false }))
    stubApi({}, unlock)
    render(<UpdateSettings />)
    const version = await screen.findByText('1.0.8')
    for (let i = 0; i < 6; i++) await userEvent.click(version)
    expect(unlock).toHaveBeenCalledOnce()
    expect(await screen.findByText(/restart argus/i)).toBeInTheDocument()
  })

  it('does not unlock on fewer than 6 clicks', async () => {
    const unlock = vi.fn(async () => ({ devTools: false }))
    stubApi({}, unlock)
    render(<UpdateSettings />)
    const version = await screen.findByText('1.0.8')
    for (let i = 0; i < 5; i++) await userEvent.click(version)
    expect(unlock).not.toHaveBeenCalled()
  })

  it('reports already-enabled instead of asking for a restart when the gate is already on', async () => {
    const unlock = vi.fn(async () => ({ devTools: true }))
    stubApi({}, unlock)
    render(<UpdateSettings />)
    const version = await screen.findByText('1.0.8')
    for (let i = 0; i < 6; i++) await userEvent.click(version)
    expect(await screen.findByText(/already enabled/i)).toBeInTheDocument()
  })
})

describe('UpdateSettings channel row', () => {
  const payload = (over: Partial<CoreUpdatePayload>): CoreUpdatePayload => ({ ...idle, ...over })

  it('renders the channel the app is on, not the channel that was requested', async () => {
    const p = payload({ channel: 'beta' })
    stubApi({ status: vi.fn(async () => p), check: vi.fn(async () => p) })
    render(<UpdateSettings />)
    expect(await screen.findByRole('switch', { name: /prerelease builds/i })).toBeChecked()
  })

  it('writes the channel through settings rather than a bespoke IPC call', async () => {
    const patch = vi.spyOn(settingsStore, 'patch').mockResolvedValue(undefined)
    render(<UpdateSettings />)
    await userEvent.click(await screen.findByRole('switch', { name: /prerelease builds/i }))
    expect(patch).toHaveBeenCalledWith({ updates: { channel: 'beta' } })
  })

  it('switches back to stable from the prerelease track', async () => {
    const p = payload({ channel: 'beta' })
    stubApi({ status: vi.fn(async () => p), check: vi.fn(async () => p) })
    const patch = vi.spyOn(settingsStore, 'patch').mockResolvedValue(undefined)
    render(<UpdateSettings />)
    await userEvent.click(await screen.findByRole('switch', { name: /prerelease builds/i }))
    expect(patch).toHaveBeenCalledWith({ updates: { channel: 'stable' } })
  })

  it('cannot be switched while bytes are staged, and says why', async () => {
    const p = payload({ channel: 'beta', status: { phase: 'ready', version: '2.2.0-beta.1' } })
    stubApi({ status: vi.fn(async () => p), check: vi.fn(async () => p) })
    render(<UpdateSettings />)
    // autoInstallOnAppQuit means those bytes land on the next quit regardless — a control that
    // appeared to cancel that would be lying.
    expect(await screen.findByRole('switch', { name: /prerelease builds/i })).toBeDisabled()
    expect(screen.getByText(/restart to finish installing 2\.2\.0-beta\.1/i)).toBeInTheDocument()
  })

  it('is also locked mid-download, where there is no version to name yet', async () => {
    const p = payload({ channel: 'beta', status: { phase: 'downloading', percent: 40 } })
    stubApi({ status: vi.fn(async () => p), check: vi.fn(async () => p) })
    render(<UpdateSettings />)
    expect(await screen.findByRole('switch', { name: /prerelease builds/i })).toBeDisabled()
    expect(screen.getByText(/wait for the download in progress/i)).toBeInTheDocument()
    expect(screen.queryByText(/undefined/i)).not.toBeInTheDocument()
  })

  it('does not offer a channel in a build that cannot update at all', async () => {
    const p = payload({ status: { phase: 'unsupported', reason: 'no' } })
    stubApi({ status: vi.fn(async () => p), check: vi.fn(async () => p) })
    render(<UpdateSettings />)
    await screen.findByText('1.0.8')
    expect(screen.queryByRole('switch', { name: /prerelease builds/i })).not.toBeInTheDocument()
  })

  it('labels a downgrade Install, not Download', async () => {
    const p = payload({
      currentVersion: '2.2.0-beta.1',
      status: { phase: 'available', version: '2.1.2', downgrade: true }
    })
    stubApi({ status: vi.fn(async () => p), check: vi.fn(async () => p) })
    render(<UpdateSettings />)
    expect(await screen.findByRole('button', { name: /install 2\.1\.2/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument()
  })
})

describe('keep everything up to date', () => {
  /** Stubs settings (for the toggle's checked state) and, optionally, the currency payload (for
   *  the status line) and a `settingsStore.patch` spy (for asserting the write), then renders. */
  function renderWithSettings(
    settings: { updates: { channel: UpdateChannel; auto: boolean } },
    opts: { patch?: ReturnType<typeof vi.fn>; currency?: CurrencyPayload } = {}
  ): ReturnType<typeof render> {
    stubApi(
      {},
      undefined,
      settingsPayloadFor(settings.updates.channel, settings.updates.auto),
      opts.currency ?? idleCurrency
    )
    if (opts.patch) {
      vi.spyOn(settingsStore, 'patch').mockImplementation(
        opts.patch as unknown as typeof settingsStore.patch
      )
    }
    return render(<UpdateSettings />)
  }

  it('renders the toggle on by default', async () => {
    renderWithSettings({ updates: { channel: 'stable', auto: true } })
    expect(await screen.findByLabelText('Keep everything up to date')).toBeChecked()
  })

  it('patches the setting when switched off', async () => {
    const patch = vi.fn()
    renderWithSettings({ updates: { channel: 'stable', auto: true } }, { patch })
    await userEvent.click(await screen.findByLabelText('Keep everything up to date'))
    expect(patch).toHaveBeenCalledWith({ updates: { auto: false } })
  })

  it('says everything is current when nothing is held back', async () => {
    renderWithSettings(
      { updates: { channel: 'stable', auto: true } },
      { currency: { auto: true, lastSurveyAt: new Date().toISOString(), blocked: [], busy: false } }
    )
    expect(await screen.findByText(/everything current/i)).toBeInTheDocument()
  })

  it('counts held-back items', async () => {
    renderWithSettings(
      { updates: { channel: 'stable', auto: true } },
      {
        currency: {
          auto: true,
          lastSurveyAt: new Date().toISOString(),
          blocked: [
            {
              domain: 'hive-reference',
              key: 'reference/a.md',
              label: 'a.md',
              from: 'x',
              to: 'y',
              verdict: 'blocked',
              reason: { kind: 'local-edits' }
            },
            {
              domain: 'pack',
              key: 'cg',
              label: 'CG',
              from: '1',
              to: '2',
              verdict: 'blocked',
              reason: { kind: 'new-dependency' }
            }
          ],
          busy: false
        }
      }
    )
    expect(await screen.findByText(/2 items held back/i)).toBeInTheDocument()
  })

  it('uses singular wording for exactly one held-back item', async () => {
    renderWithSettings(
      { updates: { channel: 'stable', auto: true } },
      {
        currency: {
          auto: true,
          lastSurveyAt: new Date().toISOString(),
          blocked: [
            {
              domain: 'pack',
              key: 'cg',
              label: 'CG',
              from: '1',
              to: '2',
              verdict: 'blocked',
              reason: { kind: 'new-dependency' }
            }
          ],
          busy: false
        }
      }
    )
    expect(await screen.findByText(/1 item held back/i)).toBeInTheDocument()
    expect(screen.queryByText(/1 items held back/i)).not.toBeInTheDocument()
  })

  it('says nothing has been checked yet when there is no anchor', async () => {
    renderWithSettings(
      { updates: { channel: 'stable', auto: true } },
      { currency: { auto: true, lastSurveyAt: null, blocked: [], busy: false } }
    )
    expect(await screen.findByText(/not checked yet/i)).toBeInTheDocument()
  })
})
