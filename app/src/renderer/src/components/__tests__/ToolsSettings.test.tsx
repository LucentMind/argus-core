// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolsSettings } from '../settings/ToolsSettings'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import { settingsStore } from '../../lib/settingsStore'

function payload(mut?: (p: SettingsPayload) => void): SettingsPayload {
  const p: SettingsPayload = {
    settings: defaultSettings(),
    resolvedTools: {
      traceDir: { value: null, source: 'default' },
      parseBin: { value: null, source: 'default' }
    },
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
  mut?.(p)
  return p
}

beforeEach(() => {
  settingsStore.reset()
  window.argus = {
    settings: {
      get: vi.fn(async () => payload()),
      patch: vi.fn(async () => payload()),
      probeTools: vi.fn(async () => ({
        parseBin: { path: 'C:\\bin\\sample-parse.exe', version: 'sample-parse 0.3.0' },
        traceDir: { path: 'C:\\tools', found: true }
      })),
      pickPath: vi.fn(async () => 'C:\\picked\\sample-parse.exe'),
      onChanged: vi.fn(() => () => {})
    }
  } as never
})

describe('ToolsSettings', () => {
  it('runs probeTools on mount and shows found chips with version', async () => {
    render(<ToolsSettings payload={payload()} />)
    expect(await screen.findByText(/found · sample-parse 0\.3\.0/)).toBeTruthy()
    expect(await screen.findByText('found')).toBeTruthy()
    expect(window.argus.settings.probeTools).toHaveBeenCalledTimes(1)
  })

  it('shows the env-override badge when a source is env', () => {
    const p = payload((p) => {
      p.resolvedTools.parseBin = { value: 'C:\\env.exe', source: 'env' }
    })
    render(<ToolsSettings payload={p} />)
    expect(screen.getByText(/ARGUS_PARSE_BIN/)).toBeTruthy()
  })

  it('Browse picks a file and patches tools.parseBin', async () => {
    render(<ToolsSettings payload={payload()} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Browse' })[0])
    await vi.waitFor(() =>
      expect(window.argus.settings.patch).toHaveBeenCalledWith({
        tools: { parseBin: 'C:\\picked\\sample-parse.exe' }
      })
    )
    expect(window.argus.settings.pickPath).toHaveBeenCalledWith('file')
  })

  it('Re-run checks calls probeTools again', async () => {
    render(<ToolsSettings payload={payload()} />)
    await screen.findByText(/found · sample-parse 0\.3\.0/)
    fireEvent.click(screen.getByRole('button', { name: 'Re-run checks' }))
    await vi.waitFor(() => expect(window.argus.settings.probeTools).toHaveBeenCalledTimes(2))
  })
})
