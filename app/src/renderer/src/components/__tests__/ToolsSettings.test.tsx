// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolsSettings } from '../settings/ToolsSettings'
import {
  defaultSettings,
  type SettingsPayload,
  type ResolvedToolRow
} from '../../../../shared/settings'
import { settingsStore } from '../../lib/settingsStore'

const row: ResolvedToolRow = {
  id: 'sample-parse',
  displayName: 'sample-parse binary',
  description: 'Rust BINLOG decoder',
  kind: 'exe',
  envVar: 'ARGUS_PARSE_BIN',
  settingsKey: 'parseBin',
  settingsValue: '',
  value: null,
  source: 'default'
}

function payload(mut?: (p: SettingsPayload) => void): SettingsPayload {
  const p: SettingsPayload = {
    settings: defaultSettings(),
    resolvedTools: [{ ...row }],
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
      probeTools: vi.fn(async () => [
        { id: 'sample-parse', ok: true, chip: 'found · 0.3.1', detail: 'C:/x · 0.3.1' }
      ]),
      pickPath: vi.fn(async () => 'C:\\new'),
      onChanged: vi.fn(() => () => {})
    }
  } as never
})

describe('ToolsSettings', () => {
  it('runs probeTools on mount and shows the found chip', async () => {
    render(<ToolsSettings payload={payload()} />)
    expect(await screen.findByText(/found · 0\.3\.1/)).toBeTruthy()
    expect(window.argus.settings.probeTools).toHaveBeenCalledTimes(1)
  })

  it('shows the env-override badge when a row source is env', () => {
    const p = payload((p) => {
      p.resolvedTools[0] = { ...row, source: 'env' }
    })
    render(<ToolsSettings payload={p} />)
    expect(screen.getByText(/ARGUS_PARSE_BIN/)).toBeTruthy()
  })

  it('reset patches the row settingsKey to null', () => {
    const p = payload((p) => {
      p.resolvedTools[0] = { ...row, settingsValue: 'C:\\old', source: 'settings' }
    })
    render(<ToolsSettings payload={p} />)
    fireEvent.click(screen.getByRole('button', { name: /reset/i }))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({ tools: { parseBin: null } })
  })

  it('committing a typed value patches the row settingsKey', () => {
    render(<ToolsSettings payload={payload()} />)
    const input = screen.getByLabelText('sample-parse binary path')
    fireEvent.change(input, { target: { value: 'C:\\new' } })
    fireEvent.blur(input)
    expect(window.argus.settings.patch).toHaveBeenCalledWith({ tools: { parseBin: 'C:\\new' } })
  })

  it('Browse picks a file and patches the row settingsKey', async () => {
    render(<ToolsSettings payload={payload()} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Browse' })[0])
    await vi.waitFor(() =>
      expect(window.argus.settings.patch).toHaveBeenCalledWith({ tools: { parseBin: 'C:\\new' } })
    )
    expect(window.argus.settings.pickPath).toHaveBeenCalledWith('file')
  })

  it('Re-run checks calls probeTools again', async () => {
    render(<ToolsSettings payload={payload()} />)
    await screen.findByText(/found · 0\.3\.1/)
    fireEvent.click(screen.getByRole('button', { name: 'Re-run checks' }))
    await vi.waitFor(() => expect(window.argus.settings.probeTools).toHaveBeenCalledTimes(2))
  })

  it('shows an empty-state message when no tools are declared', () => {
    const p = payload((p) => {
      p.resolvedTools = []
    })
    render(<ToolsSettings payload={p} />)
    expect(screen.getByText(/No analysis tools declared/)).toBeTruthy()
  })
})
