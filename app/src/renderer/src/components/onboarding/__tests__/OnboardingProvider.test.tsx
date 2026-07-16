// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OnboardingProvider } from '../OnboardingProvider'
import { settingsStore } from '../../../lib/settingsStore'
import { onboardingReplay } from '../../../lib/onboardingStore'
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
    settings: {
      get: vi.fn(async () => payload()),
      patch: vi.fn(async () => payload()),
      onChanged: vi.fn(() => () => {})
    },
    agent: { authStatus: vi.fn(async () => ({ ok: true, detail: 'ok', email: 'x@y' })) },
    onboarding: {
      seedSample: vi.fn(async () => ({ slug: 'sample-onboarding', evidenceIds: [1] }))
    }
  } as never
  settingsStore.reset()
  onboardingReplay.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  onboardingReplay.clear()
})

describe('OnboardingProvider', () => {
  it('auto-opens the wizard on true first run', async () => {
    render(<OnboardingProvider onNavigate={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('wizard-step-welcome')).toBeTruthy())
  })

  it('renders nothing when already completed', async () => {
    window.argus.settings.get = vi.fn(async () =>
      payload((p) => {
        p.settings.onboarding.completedAt = '2026-07-15T00:00:00Z'
      })
    )
    settingsStore.reset()
    const { container } = render(<OnboardingProvider onNavigate={vi.fn()} />)
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
    render(<OnboardingProvider onNavigate={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('wizard-step-welcome')).toBeTruthy())
  })

  it('re-opens after being dismissed this session when replay is requested', async () => {
    render(<OnboardingProvider onNavigate={vi.fn()} />)
    // auto-opens on first run
    await waitFor(() => expect(screen.getByTestId('wizard-step-welcome')).toBeTruthy())
    // user skips the wizard → dismissed for this session
    fireEvent.click(screen.getByRole('button', { name: /skip setup/i }))
    await waitFor(() => expect(screen.queryByTestId('wizard-step-welcome')).toBeNull())
    // user later clicks "Re-run onboarding" (fires an explicit replay request)
    act(() => onboardingReplay.request())
    await waitFor(() => expect(screen.getByTestId('wizard-step-welcome')).toBeTruthy())
  })

  it('replay opens the wizard even for an existing user with cases who never onboarded', async () => {
    window.argus.cases.list = vi.fn(async () => [{ slug: 'existing-case' }])
    // default settings: completedAt null, phase1Done false → shouldOpenOnboarding is false with cases
    render(<OnboardingProvider onNavigate={vi.fn()} />)
    await waitFor(() => expect(window.argus.cases.list).toHaveBeenCalled())
    expect(screen.queryByTestId('wizard-step-welcome')).toBeNull()
    act(() => onboardingReplay.request())
    await waitFor(() => expect(screen.getByTestId('wizard-step-welcome')).toBeTruthy())
  })
})
