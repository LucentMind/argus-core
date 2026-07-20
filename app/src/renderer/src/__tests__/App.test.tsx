// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import App from '../App'
import { settingsStore } from '../lib/settingsStore'
import { accessStore } from '../lib/accessStore'
import { __resetEscapeLayersForTest } from '../lib/escapeLayer'
import { defaultSettings, type SettingsPayload } from '../../../shared/settings'

function settingsPayload(): SettingsPayload {
  const settings = defaultSettings()
  // Non-null completedAt keeps OnboardingProvider's SetupWizard from mounting
  // over the toolbar and swallowing the clicks this test drives.
  settings.onboarding.completedAt = '2026-01-01T00:00:00.000Z'
  return {
    settings,
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
}

const globalMetrics = {
  totalCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  byModel: [],
  turns: { total: 0, error: 0 },
  tools: { total: 0, denied: 0, byDecision: {}, byRisk: {} },
  findings: { total: 0, accepted: 0, rejected: 0, pending: 0 },
  latencyMs: { turnP50: null, turnP95: null },
  resolvedCases: 0,
  costPerResolvedCaseUsd: null
}

const memoryTopics = { topics: [], indexLines: 0, capLines: 200 }

beforeEach(() => {
  __resetEscapeLayersForTest()
  settingsStore.reset()
  accessStore.reset()
  window.argus = {
    cases: {
      list: vi.fn(async () => [])
    },
    panels: {
      onCite: vi.fn(() => () => {}),
      onDraft: vi.fn(() => () => {})
    },
    proposals: {
      list: vi.fn(async () => ({ proposals: [] }))
    },
    settings: {
      get: vi.fn(async () => settingsPayload()),
      patch: vi.fn(async () => settingsPayload()),
      onChanged: vi.fn(() => () => {})
    },
    metrics: {
      global: vi.fn(async () => globalMetrics),
      case: vi.fn(async () => globalMetrics)
    },
    access: {
      get: vi.fn(async () => ({ access: { skills: {}, memory: {} }, loadError: null })),
      onChanged: vi.fn(() => () => {})
    },
    memory: {
      topics: vi.fn(async () => memoryTopics),
      audit: vi.fn(async () => [])
    },
    // CaseDashboard subscribes to sync progress on mount and CaseCard/openCase
    // call the other two; without these the dashboard throws during render and
    // every toggle assertion below fails for an unrelated reason.
    jira: {
      onSyncProgress: vi.fn(() => () => {}),
      markReviewed: vi.fn(async () => undefined),
      syncAll: vi.fn(async () => undefined)
    }
  } as never
})

afterEach(() => __resetEscapeLayersForTest())

describe('App: toolbar icon toggles', () => {
  it('a second Observability click returns to the previous view', async () => {
    render(<App />)
    await userEvent.click(screen.getByLabelText('Observability'))
    expect(screen.getByRole('heading', { name: 'Observability' })).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Observability'))
    expect(screen.queryByRole('heading', { name: 'Observability' })).not.toBeInTheDocument()
  })

  it('a second Settings click returns to the previous view', async () => {
    render(<App />)
    await userEvent.click(screen.getByLabelText('Settings'))
    expect(screen.getByLabelText('Settings sections')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Settings'))
    expect(screen.queryByLabelText('Settings sections')).not.toBeInTheDocument()
  })

  it('a deep link to a settings page switches page instead of closing', async () => {
    render(<App />)
    await userEvent.click(screen.getByLabelText('Settings'))
    // navigate to a non-default page via the settings nav, then re-click the gear
    await userEvent.click(screen.getByRole('button', { name: /memory/i }))
    await userEvent.click(screen.getByLabelText('Settings'))
    // the gear passes no page -> toggles shut, proving the carve-out is arg-based
    // (a real deep link with a page argument is covered directly by the
    // reducer unit tests in lib/__tests__/viewReducer.test.ts, since no DOM
    // call site reaches that branch)
    expect(screen.queryByLabelText('Settings sections')).not.toBeInTheDocument()
  })

  it('the gear still toggles Settings shut after a Settings -> Observability -> toggle-shut sequence', async () => {
    render(<App />)
    // 1. Home -> Settings
    await userEvent.click(screen.getByLabelText('Settings'))
    expect(screen.getByLabelText('Settings sections')).toBeInTheDocument()
    // 2. Settings -> Observability
    await userEvent.click(screen.getByLabelText('Observability'))
    expect(screen.getByRole('heading', { name: 'Observability' })).toBeInTheDocument()
    // 3. Observability -> toggle shut. `prevView` must have stayed Home (the
    // base view from step 1) rather than being corrupted to Settings, so this
    // lands on Home, not back on Settings.
    await userEvent.click(screen.getByLabelText('Observability'))
    expect(screen.queryByRole('heading', { name: 'Observability' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Settings sections')).not.toBeInTheDocument()
    // 4. Gear click from Home opens Settings again (prevView is still Home).
    await userEvent.click(screen.getByLabelText('Settings'))
    expect(screen.getByLabelText('Settings sections')).toBeInTheDocument()
    // 5. A second gear click must actually toggle it shut -- under the bug,
    // `prevView` had been corrupted to Settings itself, making this a
    // permanent no-op that left Settings undismissable.
    await userEvent.click(screen.getByLabelText('Settings'))
    expect(screen.queryByLabelText('Settings sections')).not.toBeInTheDocument()
  })

  it('Escape still closes Settings after a Settings -> Observability -> toggle-shut sequence', async () => {
    render(<App />)
    await userEvent.click(screen.getByLabelText('Settings'))
    expect(screen.getByLabelText('Settings sections')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Observability'))
    expect(screen.getByRole('heading', { name: 'Observability' })).toBeInTheDocument()
    // Toggling Observability shut returns to the base view (Home), not Settings.
    await userEvent.click(screen.getByLabelText('Observability'))
    expect(screen.queryByLabelText('Settings sections')).not.toBeInTheDocument()
    // Reopen Settings from Home, then confirm Escape (wired to closeSettings,
    // i.e. setView(prevView)) actually dismisses it instead of no-oping on a
    // self-referential prevView.
    await userEvent.click(screen.getByLabelText('Settings'))
    expect(screen.getByLabelText('Settings sections')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByLabelText('Settings sections')).not.toBeInTheDocument()
  })
})
