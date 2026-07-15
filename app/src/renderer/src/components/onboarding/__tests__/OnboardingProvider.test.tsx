// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OnboardingProvider } from '../OnboardingProvider'
import { settingsStore } from '../../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../../shared/settings'

function payload(mut?: (p: SettingsPayload) => void): SettingsPayload {
  const p: SettingsPayload = {
    settings: defaultSettings(),
    resolvedTools: [],
    dataRoot: { path: '', fromEnv: false },
    loadError: null
  }
  mut?.(p)
  return p
}

beforeEach(() => {
  window.argus = {
    cases: { list: vi.fn(async () => []) },
    settings: { get: vi.fn(async () => payload()), onChanged: vi.fn(() => () => {}) },
    agent: { authStatus: vi.fn(async () => ({ ok: true, detail: 'ok', email: 'x@y' })) },
    onboarding: {
      seedSample: vi.fn(async () => ({ slug: 'sample-onboarding', evidenceIds: [1] }))
    }
  } as never
  settingsStore.reset()
})

afterEach(() => vi.restoreAllMocks())

describe('OnboardingProvider', () => {
  it('auto-opens the wizard on true first run', async () => {
    render(<OnboardingProvider onOpenCase={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('wizard-step-welcome')).toBeTruthy())
  })

  it('renders nothing when already completed', async () => {
    window.argus.settings.get = vi.fn(async () =>
      payload((p) => {
        p.settings.onboarding.completedAt = '2026-07-15T00:00:00Z'
      })
    )
    settingsStore.reset()
    const { container } = render(<OnboardingProvider onOpenCase={vi.fn()} />)
    await waitFor(() => expect(window.argus.settings.get).toHaveBeenCalled())
    expect(container.querySelector('[data-testid^="wizard-step"]')).toBeNull()
  })

  it('re-opens the wizard on replay: completedAt cleared, phase1Done true, cases exist', async () => {
    window.argus.cases.list = vi.fn(async () => [{ slug: 'existing-case' }])
    window.argus.settings.get = vi.fn(async () =>
      payload((p) => {
        p.settings.onboarding.completedAt = null
        p.settings.onboarding.phase1Done = true
      })
    )
    settingsStore.reset()
    render(<OnboardingProvider onOpenCase={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('wizard-step-welcome')).toBeTruthy())
  })
})
