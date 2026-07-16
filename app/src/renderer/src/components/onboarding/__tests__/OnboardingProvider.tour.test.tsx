// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OnboardingProvider } from '../OnboardingProvider'
import { settingsStore } from '../../../lib/settingsStore'
import { connectorsStore } from '../../../lib/connectorsStore'
import { tourStore } from '../../../lib/tourStore'
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
      onChanged: vi.fn(() => () => {}),
      patch: vi.fn(async () => payload())
    },
    agent: { authStatus: vi.fn(async () => ({ ok: true, detail: 'ok', email: 'x@y' })) },
    packs: {
      list: vi.fn(async () => ({
        packs: [
          {
            id: 'p',
            displayName: 'P',
            installedVersion: null,
            loadedVersion: '1',
            platform: null,
            pendingRelaunch: false,
            binaries: []
          }
        ],
        error: null
      }))
    },
    connectors: {
      get: vi.fn(async () => ({ oauth: {} })),
      onChanged: vi.fn(() => () => {})
    },
    onboarding: {
      seedSample: vi.fn(async () => ({ slug: 'sample-onboarding', evidenceIds: [1] }))
    },
    sessions: { list: vi.fn(async () => [{ id: 1 }]) }
  } as never
  settingsStore.reset()
  connectorsStore.reset()
  tourStore.exitTour()
})

afterEach(() => {
  vi.restoreAllMocks()
  connectorsStore.reset()
})

// Button lookups re-query by role/name each time (rather than caching the
// element) since the wizard swaps the "Continue"/"Finish" label per step.
async function clickWhenEnabled(name: RegExp): Promise<void> {
  await waitFor(() =>
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false)
  )
  fireEvent.click(screen.getByRole('button', { name }))
}

describe('OnboardingProvider → tour handoff', () => {
  it('starts the tour and navigates to the sample case on wizard finish', async () => {
    const onNavigate = vi.fn()
    render(<OnboardingProvider onNavigate={onNavigate} />)
    await waitFor(() => expect(screen.getByTestId('wizard-step-welcome')).toBeTruthy())

    // Wizard order (WIZARD_STEPS): welcome -> claude -> integrations -> seed -> pack.
    // welcome -> claude (gate defaults true on welcome)
    await clickWhenEnabled(/continue/i)
    await waitFor(() => expect(screen.getByTestId('wizard-step-claude')).toBeTruthy())

    // claude -> integrations (gate opens once authStatus resolves ok)
    await clickWhenEnabled(/continue/i)
    await waitFor(() => expect(screen.getByTestId('wizard-step-integrations')).toBeTruthy())

    // integrations -> seed (integrations step never closes the gate)
    await clickWhenEnabled(/continue/i)
    await waitFor(() => expect(screen.getByTestId('wizard-step-seed')).toBeTruthy())

    // seed -> pack (gate opens once seedSample resolves; seed is second-to-last)
    await waitFor(() => expect(screen.getByText(/sample case ready/i)).toBeTruthy())
    await clickWhenEnabled(/continue/i)
    await waitFor(() => expect(screen.getByTestId('wizard-step-pack')).toBeTruthy())

    // pack is the final, non-gating step -> Finish fires the tour handoff
    await clickWhenEnabled(/finish/i)

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('case', 'sample-onboarding'))
    expect(tourStore.get().open).toBe(true)
  })
})
