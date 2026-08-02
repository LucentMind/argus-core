// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import App from '../App'
import { settingsStore } from '../lib/settingsStore'
import { accessStore } from '../lib/accessStore'
import { updateStore } from '../lib/updateStore'
import { uiStore } from '../lib/uiStore'
import { __resetEscapeLayersForTest } from '../lib/escapeLayer'
import { defaultSettings, type SettingsPayload } from '../../../shared/settings'

/**
 * A thin pass-through wrapper, not a behaviour change: every call delegates straight to the real
 * `AmbientCanvas`, so every test in this file that doesn't read `lastAmbientCanvasProps` is
 * exercising the genuine component. The capture is what lets the anchor-Provider test below prove
 * `App` actually threads its own anchor STATE down to consumers — as opposed to the
 * `AmbientAnchorContext` default no-ops, which look identical from the DOM (the ref callbacks
 * still get called; they just don't move any pixels) and would leave the dynamic theme unanchored
 * with every other assertion in this suite still green.
 */
let lastAmbientCanvasProps: { light: HTMLElement | null; cutoff: HTMLElement | null } | null = null
vi.mock('../components/AmbientCanvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/AmbientCanvas')>()
  return {
    ...actual,
    AmbientCanvas: (props: Parameters<typeof actual.AmbientCanvas>[0]) => {
      lastAmbientCanvasProps = { light: props.light, cutoff: props.cutoff }
      return <actual.AmbientCanvas {...props} />
    }
  }
})

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
  updateStore.clearForTests()
  uiStore.setDynamicTheme(false)
  lastAmbientCanvasProps = null
  window.argus = {
    cases: {
      list: vi.fn(async () => [])
    },
    panels: {
      onCite: vi.fn(() => () => {}),
      onDraft: vi.fn(() => () => {})
    },
    proposals: {
      list: vi.fn(async () => ({ proposals: [] })),
      onChanged: vi.fn(() => () => {})
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
    usage: {
      stats: vi.fn(async () => ({
        hygiene: { staleDays: 45, minRecalls: 3, trackingStartedAt: '' },
        skills: [],
        memory: [],
        references: [],
        archived: []
      }))
    },
    // CaseDashboard subscribes to sync progress on mount and CaseCard/openCase
    // call the other two; without these the dashboard throws during render and
    // every toggle assertion below fails for an unrelated reason.
    jira: {
      onSyncProgress: vi.fn(() => () => {}),
      markReviewed: vi.fn(async () => undefined),
      syncAll: vi.fn(async () => undefined)
    },
    // OverrideBanner (Guard 3) subscribes on every Settings mount; the real preload exposes
    // this bridge unconditionally (main enforces the dev-tools gate), so the test stub must too.
    devPrompts: {
      overrides: vi.fn(async () => []),
      clearAll: vi.fn(async () => ({
        entries: [],
        modes: [],
        activeOverrideIds: [],
        loadError: null
      })),
      onChanged: vi.fn(() => () => {})
    },
    // UpdateBanner mounts app-wide (Task 4) and starts the update store on mount.
    update: {
      status: vi.fn(async () => ({ currentVersion: '1.0.0', status: { phase: 'idle' } })),
      check: vi.fn(async () => ({ currentVersion: '1.0.0', status: { phase: 'idle' } })),
      download: vi.fn(async () => ({ currentVersion: '1.0.0', status: { phase: 'idle' } })),
      restart: vi.fn(async () => {}),
      onChanged: vi.fn(() => () => {})
    }
  } as never
})

afterEach(() => {
  __resetEscapeLayersForTest()
  uiStore.setDynamicTheme(false)
})

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

describe('App: ambient anchor Provider', () => {
  // `lib/__tests__/ambientAnchors.test.tsx` covers the claim/release SLOT contract in detail,
  // against a hand-built harness that supplies its own Provider. What that file cannot catch is
  // App itself failing to render `AmbientAnchorContext.Provider` at all — every consumer
  // (`TopBar`, `CaseDashboard`, `CaseWorkspace`) would then silently read the context's no-op
  // defaults instead of App's real `useAmbientAnchorState()`, the ref callbacks would still get
  // called (so nothing throws and no DOM assertion about the refs existing would fail), and the
  // dynamic theme would go unanchored on every view with a fully green suite otherwise. These
  // tests render the real `App` end to end and check that a real anchor element comes out the
  // other side of `AmbientCanvas`'s props — not just that some Provider-shaped thing exists.
  it('threads the settings anchors from TopBar through to AmbientCanvas', async () => {
    uiStore.setDynamicTheme(true)
    render(<App />)
    await userEvent.click(screen.getByLabelText('Settings'))
    const title = await screen.findByTestId('settings-title')
    await waitFor(() => {
      expect(lastAmbientCanvasProps?.light).toBe(title)
      expect(lastAmbientCanvasProps?.cutoff).toBe(screen.getByRole('banner'))
    })
  })

  it('threads home’s own anchors through to AmbientCanvas', async () => {
    uiStore.setDynamicTheme(true)
    render(<App />)
    // CaseDashboard's greeting `<h1>` is home's light anchor (see CaseDashboard.tsx) — the only
    // level-1 heading on the home view; the wordmark in TopBar is a `<span>`, not a heading.
    const light = screen.getByRole('heading', { level: 1 })
    await waitFor(() => {
      expect(lastAmbientCanvasProps?.light).toBe(light)
    })
  })

  it('renders no main-window title bar strip — the header carries the window controls now', () => {
    const { container } = render(<App />)
    // `.argus-titlebar-inset` is TitleBarStrip's own class, unused by TopBar (`.argus-header-inset`
    // instead); a non-empty match here would mean a bare strip is back above the header.
    expect(container.querySelectorAll('.argus-titlebar-inset')).toHaveLength(0)
    expect(screen.getByRole('banner')).toBeInTheDocument()
  })
})
