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

describe('App: the chrome ambient light', () => {
  it('mounts behind the chrome on a case, at the window top edge', async () => {
    uiStore.setDynamicTheme(true)
    render(<App />)
    expect(screen.queryByTestId('chrome-ambient')).toBeNull()
    await userEvent.click(screen.getByText('open NAV-1'))
    const layer = screen.getByTestId('chrome-ambient')
    // `chrome-ambient` is what pins it to the window's top edge and pushes it behind the chrome
    // (theme-dynamic.css) — the whole point, since the light used to start one bar-height lower.
    // It is a plain CSS class rather than Tailwind utilities on purpose; see the rule's comment.
    expect(layer.className).toContain('chrome-ambient')
    // The canvas still needs the case variant's own geometry rules to size itself.
    expect(layer.classList.contains('dyn-case')).toBe(true)
    expect(layer.compareDocumentPosition(screen.getByRole('banner'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    // jsdom has no WebGL, so AmbientCanvas renders its static fallback — enough to prove the
    // canvas is mounted inside this layer and nowhere else.
    expect(layer.contains(screen.getByTestId('ambient-fallback'))).toBe(true)
  })

  it('stays off on Home and Settings, and off entirely in classic mode', async () => {
    render(<App />)
    await userEvent.click(screen.getByText('open NAV-1'))
    // Classic mode: no light anywhere, even on a case.
    expect(screen.queryByTestId('chrome-ambient')).toBeNull()
    act(() => uiStore.setDynamicTheme(true))
    expect(screen.getByTestId('chrome-ambient')).toBeTruthy()
    // Settings has its own light, anchored to its masthead inside the page. A second one in
    // the chrome would double it.
    await userEvent.click(screen.getByLabelText('Settings'))
    expect(screen.queryByTestId('chrome-ambient')).toBeNull()
  })
})
