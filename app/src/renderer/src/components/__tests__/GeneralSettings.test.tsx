// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GeneralSettings } from '../settings/GeneralSettings'
import { uiStore } from '../../lib/uiStore'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'

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
  settingsStore.reset()
  window.argus = {
    settings: {
      get: vi.fn(async () => payload()),
      patch: vi.fn(async () => payload()),
      reveal: vi.fn(),
      setDataRoot: vi.fn(async () => ({ changed: true })),
      onChanged: vi.fn(() => () => {})
    },
    workspaces: {
      pick: vi.fn()
    }
  } as never
})

describe('GeneralSettings', () => {
  it('theme select writes uiStore (renderer-local), not IPC', () => {
    render(<GeneralSettings payload={payload()} />)
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'light' } })
    expect(uiStore.get().theme).toBe('light')
    expect(window.argus.settings.patch).not.toHaveBeenCalled()
  })

  it('timestamp format patches app-global settings; reset appears when non-default', () => {
    const { rerender } = render(<GeneralSettings payload={payload()} />)
    expect(screen.queryByRole('button', { name: 'Reset Timestamp format' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Timestamp format'), { target: { value: '24h' } })
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

  it('changing the data root confirms, then relaunches into the picked folder', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<GeneralSettings payload={payload((p) => (p.dataRoot.fromEnv = false))} />)
    const btn = screen.getByRole('button', { name: 'Change…' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(window.argus.settings.setDataRoot).toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('changing the data root does nothing if the user cancels the confirm', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<GeneralSettings payload={payload((p) => (p.dataRoot.fromEnv = false))} />)
    fireEvent.click(screen.getByRole('button', { name: 'Change…' }))
    expect(window.argus.settings.setDataRoot).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('shows "not set" and browses for a default repository', async () => {
    window.argus.workspaces.pick = vi.fn(async () => 'C:\\code\\navigator')
    render(<GeneralSettings payload={payload()} />)
    expect(screen.getByText('not set')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
    await waitFor(() =>
      expect(window.argus.settings.patch).toHaveBeenCalledWith({
        general: { defaultRepo: 'C:\\code\\navigator' }
      })
    )
  })

  it('renders the configured default repo path', () => {
    const p = payload()
    p.settings.general.defaultRepo = 'C:\\code\\navigator'
    render(<GeneralSettings payload={p} />)
    expect(screen.getByText('C:\\code\\navigator')).toBeTruthy()
  })
})
