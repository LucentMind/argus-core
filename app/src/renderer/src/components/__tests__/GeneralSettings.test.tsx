// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { GeneralSettings } from '../settings/GeneralSettings'
import { uiStore } from '../../lib/uiStore'
import { settingsStore } from '../../lib/settingsStore'
import { updateStore } from '../../lib/updateStore'
import { confirm } from '../../lib/confirmStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'

vi.mock('../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

function payload(mut?: (p: SettingsPayload) => void): SettingsPayload {
  const p: SettingsPayload = {
    settings: defaultSettings(),
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: true },
    loadError: null
  }
  mut?.(p)
  return p
}

beforeEach(() => {
  localStorage.clear()
  uiStore.setTheme('dark')
  uiStore.setDynamicTheme(false)
  settingsStore.reset()
  updateStore.clearForTests()
  window.argus = {
    settings: {
      get: vi.fn(async () => payload()),
      patch: vi.fn(async () => payload()),
      reveal: vi.fn(),
      setDataRoot: vi.fn(async () => ({ changed: true })),
      onChanged: vi.fn(() => () => {})
    },
    workspaces: {
      pick: vi.fn(async () => null),
      recent: vi.fn(async () => [])
    },
    // UpdateSettings (Task 4) now renders inside GeneralSettings and starts the
    // update store unconditionally on mount.
    update: {
      status: vi.fn(async () => ({ currentVersion: '1.0.0', status: { phase: 'idle' } })),
      check: vi.fn(async () => ({ currentVersion: '1.0.0', status: { phase: 'idle' } })),
      download: vi.fn(async () => ({ currentVersion: '1.0.0', status: { phase: 'idle' } })),
      restart: vi.fn(async () => {}),
      onChanged: vi.fn(() => () => {})
    }
  } as never
})

/** `SelectField` is a button + `role="listbox"` popup, not a native `<select>`
 *  (settingsLayout.tsx explains why): open it, then click the entry. */
function choose(label: string, option: string): void {
  fireEvent.click(screen.getByLabelText(label))
  fireEvent.click(screen.getByRole('option', { name: option }))
}

describe('GeneralSettings', () => {
  it('theme select writes uiStore (renderer-local), not IPC', () => {
    render(<GeneralSettings payload={payload()} />)
    choose('Theme', 'light')
    expect(uiStore.get().theme).toBe('light')
    expect(window.argus.settings.patch).not.toHaveBeenCalled()
  })

  it('dynamic theme switch writes uiStore (renderer-local), not IPC', () => {
    render(<GeneralSettings payload={payload()} />)
    const sw = screen.getByRole('switch', { name: 'Dynamic theme' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    expect(uiStore.get().dynamicTheme).toBe(true)
    expect(sw.getAttribute('aria-checked')).toBe('true')
    expect(window.argus.settings.patch).not.toHaveBeenCalled()
  })

  it('timestamp format patches app-global settings; reset appears when non-default', () => {
    const { rerender } = render(<GeneralSettings payload={payload()} />)
    expect(screen.queryByRole('button', { name: 'Reset Timestamp format' })).toBeNull()
    choose('Timestamp format', '24h')
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      general: { timestampFormat: '24h' }
    })
    rerender(
      <GeneralSettings payload={payload((p) => (p.settings.general.timestampFormat = '24h'))} />
    )
    expect(screen.getByRole('button', { name: 'Reset Timestamp format' })).toBeTruthy()
  })

  it('shows the data root read-only with env badge and open-folder action', () => {
    render(<GeneralSettings payload={payload()} />)
    expect(screen.getByText('C:\\Users\\x\\Argus')).toBeTruthy()
    expect(screen.getByText(/ARGUS_HOME/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }))
    expect(window.argus.settings.reveal).toHaveBeenCalledWith('dataRoot')
    expect((screen.getByRole('button', { name: 'Change…' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it('changing the data root confirms, then relaunches into the picked folder', async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    render(<GeneralSettings payload={payload((p) => (p.dataRoot.fromEnv = false))} />)
    const btn = screen.getByRole('button', { name: 'Change…' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    await waitFor(() => expect(window.argus.settings.setDataRoot).toHaveBeenCalled())
  })

  it('changing the data root does nothing if the user cancels the confirm', async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    render(<GeneralSettings payload={payload((p) => (p.dataRoot.fromEnv = false))} />)
    fireEvent.click(screen.getByRole('button', { name: 'Change…' }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(window.argus.settings.setDataRoot).not.toHaveBeenCalled()
  })
})

const ALPHA = 'C:\\repos\\alpha'
const BETA = 'C:\\repos\\beta'

/** `payload()` over `defaultSettings()` with the default-repo list seeded. */
function withDefaults(repos: string[]): SettingsPayload {
  return payload((p) => {
    p.settings.general.defaultRepos = repos
  })
}

describe('GeneralSettings default repositories', () => {
  it('lists every default repo', async () => {
    render(<GeneralSettings payload={withDefaults([ALPHA, BETA])} />)
    expect(await screen.findByText(ALPHA)).toBeInTheDocument()
    expect(screen.getByText(BETA)).toBeInTheDocument()
  })

  it('shows "not set" when the list is empty', () => {
    render(<GeneralSettings payload={withDefaults([])} />)
    expect(screen.getByText('not set')).toBeInTheDocument()
  })

  it('removes one entry without disturbing the others', async () => {
    render(<GeneralSettings payload={withDefaults([ALPHA, BETA])} />)

    fireEvent.click(await screen.findByRole('button', { name: `Remove ${ALPHA}` }))
    await waitFor(() =>
      expect(window.argus.settings.patch).toHaveBeenCalledWith({
        general: { defaultRepos: [BETA] }
      })
    )
  })

  it('appends a repo chosen from the picker', async () => {
    window.argus.workspaces.recent = vi.fn(async () => [{ path: BETA, name: 'beta' }])
    render(<GeneralSettings payload={withDefaults([ALPHA])} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add…' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'beta' }))
    await waitFor(() =>
      expect(window.argus.settings.patch).toHaveBeenCalledWith({
        general: { defaultRepos: [ALPHA, BETA] }
      })
    )
  })

  it('does not offer a repo that is already a default', async () => {
    window.argus.workspaces.recent = vi.fn(async () => [{ path: ALPHA, name: 'alpha' }])
    render(<GeneralSettings payload={withDefaults([ALPHA])} />)

    // nothing left to offer, so the trigger goes straight to the native dialog
    fireEvent.click(await screen.findByRole('button', { name: 'Add…' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
