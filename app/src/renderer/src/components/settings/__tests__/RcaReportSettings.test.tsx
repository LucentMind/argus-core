// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { RcaReportSettings } from '../RcaReportSettings'
import { defaultSettings, type SettingsPayload } from '../../../../../shared/settings'

/**
 * The destination rows moved here from the Connectors page (user-directed, 2026-08-21) — these
 * three cases came with them. The template editor below them has its own suite
 * (RcaTemplateSettings.test.tsx).
 */
function payload(mut?: (p: SettingsPayload) => void): SettingsPayload {
  const p: SettingsPayload = {
    settings: defaultSettings(),
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
  mut?.(p)
  return p
}

beforeEach(() => {
  window.argus = { settings: { patch: vi.fn(async () => payload()) } } as never
})

describe('RcaReportSettings', () => {
  it('defaults to "attach to Jira issue" and hides the space key field', () => {
    render(<RcaReportSettings payload={payload()} />)
    expect(
      screen.getByRole('combobox', { name: /technical report destination/i })
    ).toHaveTextContent('Attach markdown to the Jira issue')
    expect(screen.queryByLabelText('Confluence space key')).toBeNull()
  })

  it('switching to Confluence patches the setting', async () => {
    render(<RcaReportSettings payload={payload()} />)
    fireEvent.click(screen.getByRole('combobox', { name: /technical report destination/i }))
    fireEvent.click(screen.getByRole('option', { name: /publish a confluence page/i }))
    await waitFor(() =>
      expect(window.argus.settings.patch).toHaveBeenCalledWith({
        rca: { techDestination: 'confluence-page' }
      })
    )
  })

  it('reveals the space key field and commits it on blur', async () => {
    render(
      <RcaReportSettings
        payload={payload((p) => (p.settings.rca.techDestination = 'confluence-page'))}
      />
    )
    const input = screen.getByLabelText('Confluence space key')
    fireEvent.change(input, { target: { value: 'ENG' } })
    fireEvent.blur(input)
    await waitFor(() =>
      expect(window.argus.settings.patch).toHaveBeenCalledWith({
        rca: { confluenceSpaceKey: 'ENG' }
      })
    )
  })
})
