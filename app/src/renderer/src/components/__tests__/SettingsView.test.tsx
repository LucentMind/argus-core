// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SettingsView } from '../settings/SettingsView'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'

function payload(overrides: Partial<SettingsPayload> = {}): SettingsPayload {
  return {
    settings: defaultSettings(),
    resolvedTools: {
      traceDir: { value: null, source: 'default' },
      parseBin: { value: null, source: 'default' }
    },
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null,
    ...overrides
  }
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
      probeTools: vi.fn(async () => ({
        parseBin: { path: null, version: null },
        traceDir: { path: null, found: false }
      })),
      pickPath: vi.fn(async () => null),
      reveal: vi.fn(),
      onChanged: vi.fn(() => () => {})
    },
    agent: { authStatus: vi.fn(async () => ({ ok: true, detail: 'ready' })) }
  } as never
})

describe('SettingsView', () => {
  it('renders the rail: 3 active pages, 5 coming-soon entries', async () => {
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByRole('button', { name: /General/ })
    for (const label of ['General', 'Agent', 'Analysis Tools'])
      expect(
        (screen.getByRole('button', { name: new RegExp(label) }) as HTMLButtonElement).disabled
      ).toBe(false)
    for (const label of ['Health', 'Connectors', 'Skills', 'Memory', 'Observability'])
      expect(
        (screen.getByRole('button', { name: new RegExp(label) }) as HTMLButtonElement).disabled
      ).toBe(true)
  })

  it('switches pages via the rail', async () => {
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByRole('button', { name: /Analysis Tools/ })
    fireEvent.click(screen.getByRole('button', { name: /Analysis Tools/ }))
    expect(await screen.findByText(/sample-parse/i)).toBeTruthy()
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
