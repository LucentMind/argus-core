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

  it('similar past cases switch is off by default and patches app-global settings', () => {
    render(<GeneralSettings payload={payload()} />)
    const sw = screen.getByRole('switch', { name: 'Similar past cases' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      general: { similarPastCasesEnabled: true }
    })
  })

  it('similar past cases reset appears only when non-default', () => {
    const { rerender } = render(<GeneralSettings payload={payload()} />)
    expect(screen.queryByRole('button', { name: 'Reset Similar past cases' })).toBeNull()
    rerender(
      <GeneralSettings
        payload={payload((p) => (p.settings.general.similarPastCasesEnabled = true))}
      />
    )
    expect(screen.getByRole('button', { name: 'Reset Similar past cases' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reset Similar past cases' }))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      general: { similarPastCasesEnabled: null }
    })
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

/** Expands the default-repos disclosure (collapsed whenever the list is non-empty). Named after
 *  the shared `DisclosureBtn`, whose accessible name is "Expand …"/"Collapse …" — the same control
 *  a provider row uses. */
function openDefaults(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Expand default repositories' }))
}

describe('GeneralSettings default repositories', () => {
  it('lists every default repo once expanded', async () => {
    render(<GeneralSettings payload={withDefaults([ALPHA, BETA])} />)
    openDefaults()
    expect(await screen.findByTitle(ALPHA)).toBeInTheDocument()
    expect(screen.getByTitle(BETA)).toBeInTheDocument()
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
  })

  /**
   * Collapsed, the row still has to say what it holds — that count is the whole reason the
   * disclosure is allowed to hide the list (user-directed, 2026-08-08). Asserted alongside the
   * absence of the entries themselves, so a regression that simply stopped collapsing would not
   * satisfy it.
   */
  it('summarises the list while collapsed', () => {
    render(<GeneralSettings payload={withDefaults([ALPHA, BETA])} />)
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('Automatically linked to new cases')).toBeInTheDocument()
    expect(screen.queryByTitle(ALPHA)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand default repositories' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  /**
   * The reset eraser is gone (user-directed, 2026-08-08): per-entry Remove is how the list
   * empties, and a clear-everything button sitting where the chevron belongs gave the row two
   * competing affordances in the same corner. Pinned as an absence so it cannot drift back in
   * with the next `SettingRow` refactor.
   */
  it('offers a disclosure chevron and no reset button', () => {
    render(<GeneralSettings payload={withDefaults([ALPHA, BETA])} />)
    expect(screen.getByRole('button', { name: 'Expand default repositories' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset Default repositories' })).toBeNull()
  })

  /** Auto-expanded when empty: a collapsed row would be a summary of nothing, and the only reason
   *  to open it would be to reach `Add…`. */
  it('starts open, and says so, when the list is empty', async () => {
    render(<GeneralSettings payload={withDefaults([])} />)
    expect(screen.getByText('None — new cases start unlinked')).toBeInTheDocument()
    expect(screen.getByText(/No default repositories yet/)).toBeInTheDocument()
    // `find`, not `get`: RepoPickerMenu withholds its trigger until the recents fetch settles.
    expect(await screen.findByRole('button', { name: 'Add…' })).toBeInTheDocument()
  })

  it('removes one entry without disturbing the others', async () => {
    render(<GeneralSettings payload={withDefaults([ALPHA, BETA])} />)
    openDefaults()

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
    openDefaults()

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
    openDefaults()

    // nothing left to offer, so the trigger goes straight to the native dialog
    fireEvent.click(await screen.findByRole('button', { name: 'Add…' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
