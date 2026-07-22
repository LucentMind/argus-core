// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { KnowledgeFlowStrip } from '../KnowledgeFlowStrip'
import { settingsStore } from '../../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../../shared/settings'

function payload(dismissed: boolean): SettingsPayload {
  const settings = defaultSettings()
  settings.ui.knowledgeStripDismissed = dismissed
  return { settings, resolvedTools: [], dataRoot: { path: '', fromEnv: false }, loadError: null }
}

let current: SettingsPayload

beforeEach(() => {
  current = payload(false)
  window.argus = {
    settings: {
      get: vi.fn(async () => current),
      patch: vi.fn(async () => payload(true)),
      onChanged: vi.fn(() => () => {})
    }
  } as never
  settingsStore.reset()
})

describe('KnowledgeFlowStrip', () => {
  it('renders the pipeline with four navigating terms', async () => {
    const onNavigate = vi.fn()
    render(<KnowledgeFlowStrip onNavigate={onNavigate} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Sources' }))
    expect(onNavigate).toHaveBeenCalledWith('sources')
    await userEvent.click(screen.getByRole('button', { name: 'Library' }))
    expect(onNavigate).toHaveBeenCalledWith('library')
    await userEvent.click(screen.getByRole('button', { name: 'Proposals' }))
    expect(onNavigate).toHaveBeenCalledWith('proposals')
    await userEvent.click(screen.getByRole('button', { name: 'share back to the team' }))
    expect(onNavigate).toHaveBeenCalledWith('team')
  })

  it('dismiss persists the flag and removes the strip', async () => {
    render(<KnowledgeFlowStrip onNavigate={vi.fn()} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Dismiss knowledge flow strip' })
    )
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      ui: { knowledgeStripDismissed: true }
    })
    // patch resolves with the dismissed payload → strip unmounts
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sources' })).toBeNull())
  })

  it('renders nothing when already dismissed', async () => {
    current = payload(true)
    const { container } = render(<KnowledgeFlowStrip onNavigate={vi.fn()} />)
    // settings load async; the strip must stay empty once the payload arrives
    await waitFor(() => expect(window.argus.settings.get).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
