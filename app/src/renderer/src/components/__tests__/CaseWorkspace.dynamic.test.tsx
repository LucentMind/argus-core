// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect, useState } from 'react'
import { DynamicScope } from '../DynamicScope'
import { CaseWorkspace } from '../CaseWorkspace'
import { uiStore } from '../../lib/uiStore'
import { useAmbientAnchors } from '../../lib/ambientAnchors'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import { DEFAULT_MODE } from '../../../../shared/modes'

// jsdom has no runtime ResizeObserver; DOM lib types already declare it globally.
// PanelDock (mounted by CaseWorkspace) uses one to track its host's size.
/* eslint-disable @typescript-eslint/no-empty-function */
class RO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
/* eslint-enable @typescript-eslint/no-empty-function */
globalThis.ResizeObserver = globalThis.ResizeObserver ?? RO

function payload(): SettingsPayload {
  return {
    settings: defaultSettings(),
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: true },
    loadError: null
  }
}

beforeEach(() => {
  localStorage.clear()
  uiStore.setDynamicTheme(false)
  uiStore.setTheme('dark')
  // CaseWorkspace renders Composer, which reads the shared settingsStore singleton —
  // reset it so state doesn't leak across tests (same pattern as CaseWorkspace.test.tsx).
  settingsStore.reset()
  // CaseWorkspace probes a wide IPC surface on mount (sessions, panels, repos, evidence…) —
  // same shape as CaseWorkspace.test.tsx's beforeEach, trimmed to what mounting needs to not
  // throw. This file cares only about where the ambient band lands in the DOM, not about any
  // of this data.
  window.argus = {
    agent: {
      history: vi.fn(async () => []),
      onEvent: vi.fn(() => () => undefined),
      send: vi.fn(),
      interrupt: vi.fn(),
      authStatus: vi.fn(async () => ({ ok: true, detail: 'ready' })),
      preflight: vi.fn(async () => ({ ok: true, checks: [] })),
      onAuthChanged: vi.fn(() => () => {})
    },
    sessions: {
      list: vi.fn(async () => [{ id: 1, title: '', turnCount: 0, updatedAt: '' }])
    },
    modes: { available: vi.fn(async () => ['investigation']) },
    cases: {
      readFindings: vi.fn(async () => ''),
      setStatus: vi.fn(async () => undefined),
      setMode: vi.fn(async () => ({ sessionId: 1 }))
    },
    distill: {
      status: vi.fn(async () => null),
      retry: vi.fn(),
      redistill: vi.fn(),
      similar: vi.fn(async () => []),
      onChanged: vi.fn(() => () => undefined)
    },
    findings: { list: vi.fn(async () => []), review: vi.fn() },
    review: { worktreeHead: vi.fn(async () => null) },
    evidence: {
      list: vi.fn(async () => []),
      ingest: vi.fn(async () => []),
      onChanged: vi.fn(() => () => {}),
      onParsing: vi.fn(() => () => {}),
      scan: vi.fn(async () => ({ added: [], modified: [], missing: [], errors: [] }))
    },
    textdoc: {
      open: vi.fn(async () => ({ ok: true, title: '', lang: null, ref: null, totalLines: 0 })),
      lines: vi.fn(async (_s, from) => ({ from, lines: [] })),
      search: vi.fn(async () => undefined),
      cancelSearch: vi.fn(async () => undefined),
      onSearchHits: vi.fn(() => () => {}),
      onIndexProgress: vi.fn(() => () => {})
    },
    files: {
      list: vi.fn(async () => []),
      read: vi.fn(),
      open: vi.fn(async () => undefined),
      reveal: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => {})
    },
    packs: {
      artifactMeta: vi.fn(async () => [
        { type: 'binlog', displayName: 'Binary log', analyzeSkill: 'analyze-binlog', isText: false }
      ])
    },
    pathForFile: vi.fn(),
    workspaces: {
      list: vi.fn(async () => []),
      refs: vi.fn(async () => []),
      pick: vi.fn(async () => null),
      link: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined)
    },
    pr: {
      list: vi.fn(async () => []),
      link: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
      search: vi.fn(async () => ({ candidates: [], error: null, searchedRepos: [] })),
      statusList: vi.fn(async () => ({})),
      statusRefresh: vi.fn(async () => ({})),
      onStatusChanged: vi.fn(() => () => {})
    },
    graph: {
      status: vi.fn(async () => []),
      build: vi.fn(async () => ({ started: true })),
      install: vi.fn(async () => ({ ok: true, log: '' })),
      onBuilding: vi.fn(() => () => {}),
      onChanged: vi.fn(() => () => undefined),
      onProgress: vi.fn(() => () => {})
    },
    skills: { list: vi.fn(async () => ({ skills: [] })) },
    search: { query: vi.fn(async () => []) },
    settings: {
      get: vi.fn(async () => payload()),
      patch: vi.fn(async () => payload()),
      reveal: vi.fn(),
      onChanged: vi.fn(() => () => {})
    },
    panels: {
      list: vi.fn(async () => []),
      decls: vi.fn(async () => []),
      open: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      focus: vi.fn(async () => undefined),
      popOut: vi.fn(async () => undefined),
      dockBack: vi.fn(async () => undefined),
      setTheme: vi.fn(async () => undefined),
      setBounds: vi.fn(async () => undefined),
      setVisible: vi.fn(async () => undefined),
      closeCase: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => undefined),
      onActivate: vi.fn(() => () => undefined)
    }
  } as never
})

function renderWorkspace(): ReturnType<typeof render> {
  return render(
    <DynamicScope variant="case">
      <CaseWorkspace
        slug="NAV-1"
        activeMode={DEFAULT_MODE}
        onModeSwitched={vi.fn()}
        onOpenHit={vi.fn()}
        onOpenCitation={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenRepoFile={vi.fn()}
      />
    </DynamicScope>
  )
}

/** Counts its own mounts so the remount assertion below is about mounting,
 *  not about re-rendering. */
function MountCounter(): React.JSX.Element {
  const [id] = useState(() => ++MountCounter.mounts)
  return <span data-testid="counter">{id}</span>
}
MountCounter.mounts = 0

function Anchored(): React.JSX.Element {
  const anchors = useAmbientAnchors()
  const [seen, setSeen] = useState('')
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSeen(typeof anchors.setLight === 'function' ? 'wired' : 'missing')
  }, [anchors])
  return <span data-testid="anchors">{seen}</span>
}

describe('DynamicScope — case variant', () => {
  it('off: wrapper still renders, but with no scope class and no band', () => {
    render(
      <DynamicScope variant="case">
        <span>inner</span>
      </DynamicScope>
    )
    const root = screen.getByTestId('dynamic-case')
    expect(root.className).not.toContain('dyn-case')
    expect(screen.queryByTestId('ambient-fallback')).toBeNull()
    expect(screen.getByText('inner')).toBeTruthy()
  })

  it('on: scope class and band mount', () => {
    uiStore.setDynamicTheme(true)
    render(
      <DynamicScope variant="case">
        <span>inner</span>
      </DynamicScope>
    )
    const root = screen.getByTestId('dynamic-case')
    expect(root.className).toContain('dyn ')
    expect(root.className).toContain('dyn-case')
    expect(screen.getByTestId('ambient-fallback')).toBeTruthy()
  })

  it('carries the flex chain so the panes keep their height basis', () => {
    uiStore.setDynamicTheme(true)
    render(
      <DynamicScope variant="case">
        <span>inner</span>
      </DynamicScope>
    )
    const cls = screen.getByTestId('dynamic-case').className
    for (const c of ['flex', 'min-h-0', 'flex-1', 'flex-col']) expect(cls).toContain(c)
  })

  it('toggling does NOT remount the children', () => {
    MountCounter.mounts = 0
    render(
      <DynamicScope variant="case">
        <MountCounter />
      </DynamicScope>
    )
    expect(screen.getByTestId('counter').textContent).toBe('1')
    act(() => uiStore.setDynamicTheme(true))
    expect(screen.getByTestId('counter').textContent).toBe('1')
    act(() => uiStore.setDynamicTheme(false))
    expect(screen.getByTestId('counter').textContent).toBe('1')
  })

  it('provides anchors to children', () => {
    uiStore.setDynamicTheme(true)
    render(
      <DynamicScope variant="case">
        <Anchored />
      </DynamicScope>
    )
    expect(screen.getByTestId('anchors').textContent).toBe('wired')
  })

  it('paints no grain at all — grain is home-only', () => {
    uiStore.setDynamicTheme(true)
    render(
      <DynamicScope variant="case">
        <span>inner</span>
      </DynamicScope>
    )
    expect(document.querySelector('.dyn-grain')).toBeNull()
  })

  it('anchors the ambient band to its own element, not to a component box', async () => {
    renderWorkspace()
    await screen.findByRole('main')
    const band = document.querySelector('[data-testid="ambient-band"]')
    expect(band).not.toBeNull()
    // Inside the scope, because AmbientCanvas measures both rects relative to the
    // DynamicScope wrapper — a bar-anchored cutoff would compute negative and collapse the
    // canvas to nothing.
    expect(band?.closest('[data-testid="dynamic-case"]')).not.toBeNull()
    expect(band?.getAttribute('aria-hidden')).toBe('true')
  })
})
