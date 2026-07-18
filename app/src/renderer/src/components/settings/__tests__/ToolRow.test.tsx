// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolRow, useToolProbes } from '../ToolRow'
import type { ProbeToolRow, ResolvedToolRow } from '../../../../../shared/settings'
import { settingsStore } from '../../../lib/settingsStore'

const row: ResolvedToolRow = {
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

const okReport: ProbeToolRow[] = [
  { id: 'sample-parse', ok: true, chip: 'found · 0.3.1', detail: 'C:/x · 0.3.1' }
]

beforeEach(() => {
  settingsStore.reset()
  window.argus = {
    settings: {
      get: vi.fn(async () => ({})),
      patch: vi.fn(async () => ({})),
      probeTools: vi.fn(async () => okReport),
      pickPath: vi.fn(async () => 'C:\\new'),
      onChanged: vi.fn(() => () => {})
    },
    graph: { install: vi.fn(async () => ({ ok: true, log: 'installed' })) }
  } as never
})

/** Harness: drives the hook the way the Packs page will. */
function Harness({ r = row }: { r?: ResolvedToolRow }): React.JSX.Element {
  const { report, runChecks } = useToolProbes()
  return <ToolRow row={r} report={report} onInstalled={runChecks} />
}

describe('useToolProbes', () => {
  it('probes once on mount and exposes the report', async () => {
    render(<Harness />)
    expect(await screen.findByText(/found · 0\.3\.1/)).toBeTruthy()
    expect(window.argus.settings.probeTools).toHaveBeenCalledTimes(1)
  })
})

describe('ToolRow', () => {
  it('shows the env-override badge when the row source is env', () => {
    render(<ToolRow row={{ ...row, source: 'env' }} report={null} onInstalled={() => {}} />)
    expect(screen.getByText(/ARGUS_PARSE_BIN/)).toBeTruthy()
  })

  it('reset patches the row settingsKey to null', () => {
    render(
      <ToolRow
        row={{ ...row, settingsValue: 'C:\\old', source: 'settings' }}
        report={null}
        onInstalled={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /reset/i }))
    expect(window.argus.settings.patch).toHaveBeenCalledWith({ tools: { parseBin: null } })
  })

  it('committing a typed value patches the row settingsKey', () => {
    render(<ToolRow row={row} report={null} onInstalled={() => {}} />)
    const input = screen.getByLabelText('sample-parse binary path')
    fireEvent.change(input, { target: { value: 'C:\\new' } })
    fireEvent.blur(input)
    expect(window.argus.settings.patch).toHaveBeenCalledWith({ tools: { parseBin: 'C:\\new' } })
  })

  it('Browse picks a file and patches the row settingsKey', async () => {
    render(<ToolRow row={row} report={null} onInstalled={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
    await vi.waitFor(() =>
      expect(window.argus.settings.patch).toHaveBeenCalledWith({ tools: { parseBin: 'C:\\new' } })
    )
    expect(window.argus.settings.pickPath).toHaveBeenCalledWith('file')
  })

  it('offers Install only for an auto-installable tool whose probe failed', () => {
    const failed: ProbeToolRow[] = [
      { id: 'graphify', ok: false, chip: 'not found', detail: 'not found' }
    ]
    // not auto-installable → no button even when the probe failed
    const { unmount } = render(
      <ToolRow
        row={{ ...row, id: 'sample-parse' }}
        report={[{ id: 'sample-parse', ok: false, chip: 'not found', detail: 'not found' }]}
        onInstalled={() => {}}
      />
    )
    expect(screen.queryByRole('button', { name: /install/i })).toBeNull()
    unmount()

    render(
      <ToolRow
        row={{ ...row, id: 'graphify', settingsKey: null }}
        report={failed}
        onInstalled={() => {}}
      />
    )
    expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy()
  })

  it('installing runs the installer, shows its log, and re-probes on success', async () => {
    const onInstalled = vi.fn()
    render(
      <ToolRow
        row={{ ...row, id: 'graphify', settingsKey: null }}
        report={[{ id: 'graphify', ok: false, chip: 'not found', detail: 'not found' }]}
        onInstalled={onInstalled}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(await screen.findByText('installed')).toBeTruthy()
    expect(onInstalled).toHaveBeenCalled()
  })
})
