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
  it('renders the three steps and each navigates to its page', async () => {
    const onNavigate = vi.fn()
    render(<KnowledgeFlowStrip current="library" onNavigate={onNavigate} />)
    await userEvent.click(await screen.findByRole('button', { name: /Proposals/ }))
    expect(onNavigate).toHaveBeenCalledWith('proposals')
    await userEvent.click(screen.getByRole('button', { name: /Library/ }))
    expect(onNavigate).toHaveBeenCalledWith('library')
    await userEvent.click(screen.getByRole('button', { name: /Team/ }))
    expect(onNavigate).toHaveBeenCalledWith('team')
  })

  // The whole point of the rework: the strip reports position, so exactly one step is current
  // and it is the page being shown. The callback param is `page`, not `current` — the
  // module-level `current` payload is what the settings mock reads, and shadowing it here would
  // make this test look like it was changing that.
  it.each([
    ['proposals', /Proposals/],
    ['library', /Library/],
    ['team', /Team/]
  ] as const)('marks %s as the current step', async (page, label) => {
    render(<KnowledgeFlowStrip current={page} onNavigate={vi.fn()} />)
    const step = await screen.findByRole('button', { name: label })
    expect(step).toHaveAttribute('aria-current', 'step')
    // ...and it is the ONLY one, so the strip never claims you are in two places at once.
    expect(
      screen.getAllByRole('button').filter((b) => b.getAttribute('aria-current') === 'step')
    ).toHaveLength(1)
  })

  // The active step borrows the sidebar's own active treatment on purpose — if this drifts, the
  // rail and the strip start highlighting the same page two different ways.
  it('highlights the current step the way the settings nav does', async () => {
    render(<KnowledgeFlowStrip current="team" onNavigate={vi.fn()} />)
    expect((await screen.findByRole('button', { name: /Team/ })).className).toContain('bg-hi')
    expect(screen.getByRole('button', { name: /Library/ }).className).not.toContain('bg-hi')
  })

  it('dismiss persists the flag and removes the strip', async () => {
    render(<KnowledgeFlowStrip current="library" onNavigate={vi.fn()} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Dismiss knowledge flow strip' })
    )
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      ui: { knowledgeStripDismissed: true }
    })
    // patch resolves with the dismissed payload → strip unmounts
    await waitFor(() => expect(screen.queryByRole('button', { name: /Proposals/ })).toBeNull())
  })

  it('renders nothing when already dismissed', async () => {
    current = payload(true)
    const { container } = render(<KnowledgeFlowStrip current="library" onNavigate={vi.fn()} />)
    // settings load async; the strip must stay empty once the payload arrives
    await waitFor(() => expect(window.argus.settings.get).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
