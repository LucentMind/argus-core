// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import App from '../App'
import { settingsStore } from '../lib/settingsStore'
import { routinesStore } from '../lib/routinesStore'
import { accessStore } from '../lib/accessStore'
import { updateStore } from '../lib/updateStore'
import { uiStore } from '../lib/uiStore'
import { proposalsStore } from '../lib/proposalsStore'
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

/**
 * OnboardingProvider's own suites already cover the wizard/tour internals in detail; what App
 * owns is just the `onNavigate` WIRING — routing a (view, target) pair from the provider to the
 * right App-level navigation call (Task 8). Mocked to a bare capture, the same shape as the
 * AmbientCanvas capture above, so the wiring test below can invoke that callback directly with
 * a value no live caller inside the provider produces any more (the stale 'settings' + 'proposals'
 * deep link a pre-Task-8 tour step or wizard link could have sent) and prove App still escalates
 * it out to the proposals view rather than leaving it stranded on Settings.
 */
let lastOnboardingNavigate:
  ((view: 'case' | 'settings' | 'proposals', target?: string) => void) | null = null
vi.mock('../components/onboarding/OnboardingProvider', () => ({
  OnboardingProvider: (props: {
    onNavigate: (view: 'case' | 'settings' | 'proposals', target?: string) => void
  }) => {
    lastOnboardingNavigate = props.onNavigate
    return null
  }
}))

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
  routinesStore.reset()
  accessStore.reset()
  updateStore.clearForTests()
  proposalsStore.reset()
  uiStore.setDynamicTheme(false)
  lastAmbientCanvasProps = null
  lastOnboardingNavigate = null
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
    // ObservabilitySettings (now reachable via Settings' nav) checks for a stored Langfuse
    // secret on mount.
    secrets: {
      has: vi.fn(async () => false),
      set: vi.fn(async () => undefined)
    },
    // GeneralSettings' default-repositories row (Task 8) mounts RepoPickerMenu
    // unconditionally, which calls recent() on mount.
    workspaces: {
      pick: vi.fn(async () => null),
      recent: vi.fn(async () => [])
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
    // CaseDashboard now also mounts RoutineInbox unconditionally on Home; an empty payload
    // keeps it hidden so it doesn't affect this file's toolbar-toggle assertions.
    routines: {
      list: vi.fn(async () => ({
        routines: [],
        loadError: null,
        runningId: null,
        queued: [],
        nextRunAt: {},
        unreviewedCount: 0,
        runs: []
      })),
      onChanged: vi.fn(() => () => {}),
      markReviewed: vi.fn(),
      markAllReviewed: vi.fn()
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

/** The dashboard's own Close (`ObservabilityView.tsx`) shares its aria-label with the window's
 *  native caption button (`WindowControls.tsx`) — scoped to the heading's row so `getByLabelText`
 *  doesn't ambiguously match both. */
function closeObservabilityDashboard(): HTMLElement {
  const heading = screen.getByRole('heading', { name: 'Observability' })
  return within(heading.parentElement!).getByRole('button', { name: 'Close' })
}

describe('App: toolbar icon toggles', () => {
  // The dashboard's only entry point now (user-directed, 2026-08-08): the top bar carries no
  // Observability button of its own any more, so reaching it means Settings' nav, then the
  // page's own "Open dashboard" button; closing it returns to that same Settings page
  // (user-directed) rather than going through `prevView` the way Related History still does.
  it('opens the observability dashboard from its settings page and closes back to that page', async () => {
    render(<App />)
    await userEvent.click(screen.getByLabelText('Settings'))
    await userEvent.click(screen.getByRole('button', { name: 'Observability' }))
    await userEvent.click(screen.getByRole('button', { name: 'Open dashboard' }))
    expect(screen.getByRole('heading', { name: 'Observability' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Settings sections')).not.toBeInTheDocument()
    await userEvent.click(closeObservabilityDashboard())
    expect(screen.queryByRole('heading', { name: 'Observability' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Settings sections')).toBeInTheDocument()
    // Back on the Observability page specifically, not wherever Settings defaults to.
    expect(screen.getByRole('button', { name: 'Open dashboard' })).toBeInTheDocument()
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

  it('the gear still toggles Settings shut after a Settings -> Observability -> close sequence', async () => {
    render(<App />)
    // 1. Home -> Settings
    await userEvent.click(screen.getByLabelText('Settings'))
    expect(screen.getByLabelText('Settings sections')).toBeInTheDocument()
    // 2. Settings -> Observability's page -> its dashboard
    await userEvent.click(screen.getByRole('button', { name: 'Observability' }))
    await userEvent.click(screen.getByRole('button', { name: 'Open dashboard' }))
    expect(screen.getByRole('heading', { name: 'Observability' })).toBeInTheDocument()
    // 3. Close the dashboard -- back on Settings itself (its own entry point), not Home.
    await userEvent.click(closeObservabilityDashboard())
    expect(screen.queryByRole('heading', { name: 'Observability' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Settings sections')).toBeInTheDocument()
    // 4. The gear closes Settings from here. `prevView` must have stayed Home (the base view
    // from step 1) rather than being corrupted to Settings itself, so this lands on Home.
    await userEvent.click(screen.getByLabelText('Settings'))
    expect(screen.queryByLabelText('Settings sections')).not.toBeInTheDocument()
    // 5. A second gear click from Home must actually reopen Settings -- under the bug this
    // guards against, a corrupted `prevView` would have made step 4 a no-op and left
    // Settings permanently open instead.
    await userEvent.click(screen.getByLabelText('Settings'))
    expect(screen.getByLabelText('Settings sections')).toBeInTheDocument()
  })

  it('Escape still closes Settings after a Settings -> Observability -> close sequence', async () => {
    render(<App />)
    await userEvent.click(screen.getByLabelText('Settings'))
    expect(screen.getByLabelText('Settings sections')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Observability' }))
    await userEvent.click(screen.getByRole('button', { name: 'Open dashboard' }))
    expect(screen.getByRole('heading', { name: 'Observability' })).toBeInTheDocument()
    // Closing the dashboard returns straight to Settings.
    await userEvent.click(closeObservabilityDashboard())
    expect(screen.getByLabelText('Settings sections')).toBeInTheDocument()
    // Escape (wired to closeSettings, i.e. setView(prevView)) still dismisses it from here,
    // proving `prevView` was never touched by the Observability round trip.
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

describe('App: proposals view', () => {
  // The TopBar entrypoint is a toggle (openProposalsView), same shape as Related History and
  // Observability: a second click returns to the previous base view. Asserting on the standalone
  // shell's own "N pending" header segment rather than its "Close" IconBtn: this harness leaves
  // `window.argus.platform` unset (not 'darwin'), so WindowControls draws its own native Close
  // caption button on every view too, and the two share the accessible name "Close".
  it('opens the proposals view from the TopBar and toggles shut on second click', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Proposals' }))
    // The header's own "· N pending" segment, not ProposalQueue's identically-worded but
    // dot-less "N pending" count (both are mounted at once).
    expect(await screen.findByText(/^· \d+ pending$/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Proposals' }))
    await waitFor(() => expect(screen.queryByText(/^· \d+ pending$/)).not.toBeInTheDocument())
    expect(screen.queryByRole('navigation', { name: 'Settings sections' })).not.toBeInTheDocument()
  })

  // Deferred from Task 6: 'proposals' stays a valid `SettingsDeepLink` value even though the page
  // moved out of Settings (Task 7) — a stale wizard/tour caller could still hand App a
  // ('settings', 'proposals') pair, and gotoSettings intercepts that page id before it ever reaches
  // SettingsView. This drives that exact pair through App's real OnboardingProvider `onNavigate`
  // wiring (the mock above just captures the callback App passes down) and checks the intercept
  // lands on the proposals view, not a Settings page named "proposals".
  it('escalates a stale settings/proposals deep link out of Settings into the proposals view', async () => {
    render(<App />)
    await waitFor(() => expect(lastOnboardingNavigate).not.toBeNull())
    act(() => lastOnboardingNavigate!('settings', 'proposals'))
    expect(await screen.findByText(/^· \d+ pending$/)).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Settings sections' })).not.toBeInTheDocument()
  })
})
