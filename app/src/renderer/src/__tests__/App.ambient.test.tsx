// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import App from '../App'
import { settingsStore } from '../lib/settingsStore'
import { updateStore } from '../lib/updateStore'
import { uiStore } from '../lib/uiStore'
import { defaultSettings, type SettingsPayload } from '../../../shared/settings'

// The two views App switches between here are stubbed: this file is about WHERE the ambient
// light mounts, and mounting the real dashboard and workspace would drag in their whole IPC
// surface for a question neither of them answers any more.
vi.mock('../components/CaseDashboard', () => ({
  CaseDashboard: ({ onOpen }: { onOpen: (slug: string) => void }) => (
    <button onClick={() => onOpen('NAV-1')}>open NAV-1</button>
  )
}))
vi.mock('../components/CaseWorkspace', () => ({
  CaseWorkspace: () => <div data-testid="workspace-stub" />
}))

function settingsPayload(): SettingsPayload {
  const settings = defaultSettings()
  settings.onboarding.completedAt = '2026-01-01T00:00:00.000Z'
  return {
    settings,
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
}

beforeEach(() => {
  localStorage.clear()
  settingsStore.reset()
  updateStore.clearForTests()
  window.argus = {
    cases: {
      list: vi.fn(async () => []),
      setStatus: vi.fn(async () => undefined),
      setMode: vi.fn(async () => ({ sessionId: 9 }))
    },
    panels: {
      onCite: vi.fn(() => () => {}),
      onDraft: vi.fn(() => () => {}),
      // uiStore broadcasts theme changes to the panel windows on every set.
      setTheme: vi.fn(async () => undefined)
    },
    settings: {
      get: vi.fn(async () => settingsPayload()),
      patch: vi.fn(async () => settingsPayload()),
      onChanged: vi.fn(() => () => {})
    },
    // Settings' own surface — this file opens it to prove the chrome light does NOT follow.
    proposals: { list: vi.fn(async () => ({ proposals: [] })), onChanged: vi.fn(() => () => {}) },
    access: {
      get: vi.fn(async () => ({ access: { skills: {}, memory: {} }, loadError: null })),
      onChanged: vi.fn(() => () => {})
    },
    metrics: { global: vi.fn(async () => null), case: vi.fn(async () => null) },
    memory: { topics: vi.fn(async () => ({ topics: [], indexLines: 0, capLines: 200 })) },
    devPrompts: { overrides: vi.fn(async () => []), onChanged: vi.fn(() => () => {}) },
    modes: { available: vi.fn(async () => ['investigation', 'review']) },
    distill: { status: vi.fn(async () => null), onChanged: vi.fn(() => () => {}) },
    bundle: { export: vi.fn(async () => ({ ok: true, fileCount: 1 })) },
    jira: {
      markReviewed: vi.fn(async () => undefined),
      refreshCase: vi.fn(),
      openIssue: vi.fn()
    },
    update: {
      status: vi.fn(async () => ({ currentVersion: '1.0.0', status: { phase: 'idle' } })),
      check: vi.fn(async () => ({ currentVersion: '1.0.0', status: { phase: 'idle' } })),
      download: vi.fn(async () => ({ currentVersion: '1.0.0', status: { phase: 'idle' } })),
      restart: vi.fn(async () => {}),
      onChanged: vi.fn(() => () => {})
    }
  } as never
  // After the bridge stub: uiStore pushes both settings out to the panel windows through it.
  uiStore.setDynamicTheme(false)
  uiStore.setTheme('dark')
})

describe('App: where the ambient light mounts', () => {
  it('lights every view from the window top edge, the case included', async () => {
    uiStore.setDynamicTheme(true)
    render(<App />)
    // Home first: one canvas, inside the home scope.
    expect(
      screen.getByTestId('dynamic-home').contains(screen.getByTestId('ambient-fallback'))
    ).toBe(true)
    await userEvent.click(screen.getByText('open NAV-1'))
    // The case view lights itself too. It briefly did not: while the case aurora was a separate
    // layer mounted behind the bar, DynamicScope skipped the canvas for `case` so the two would
    // not stack. One fixed canvas spanning the chrome AND the view replaced that pair, and this
    // is the assertion that would have caught the guard surviving the merge.
    const scope = screen.getByTestId('dynamic-case')
    // jsdom has no WebGL, so AmbientCanvas renders its static fallback — enough to prove where
    // the canvas mounted.
    expect(scope.contains(screen.getByTestId('ambient-fallback'))).toBe(true)
    // Exactly one, never a second lower aurora.
    expect(screen.getAllByTestId('ambient-fallback')).toHaveLength(1)
    // The bar paints above it, which is what `z-20` on the header buys.
    expect(screen.getByRole('banner').compareDocumentPosition(scope)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('mounts nothing at all in classic mode, on any view', async () => {
    render(<App />)
    await userEvent.click(screen.getByText('open NAV-1'))
    expect(screen.queryByTestId('ambient-fallback')).toBeNull()
    act(() => uiStore.setDynamicTheme(true))
    expect(screen.getByTestId('ambient-fallback')).toBeTruthy()
    // Settings keeps its own light — anchored to the page title in the bar now, not to a
    // masthead inside the page.
    await userEvent.click(screen.getByLabelText('Settings'))
    expect(
      screen.getByTestId('dynamic-settings').contains(screen.getByTestId('ambient-fallback'))
    ).toBe(true)
  })
})
