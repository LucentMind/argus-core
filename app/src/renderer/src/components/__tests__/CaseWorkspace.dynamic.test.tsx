// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState, type ReactNode } from 'react'
import { DynamicScope, type DynamicVariant } from '../DynamicScope'
import { CaseWorkspace } from '../CaseWorkspace'
import { uiStore } from '../../lib/uiStore'
import {
  AmbientAnchorContext,
  useAmbientAnchorState,
  type AmbientAnchors
} from '../../lib/ambientAnchors'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import { DEFAULT_MODE } from '../../../../shared/modes'

// DynamicScope no longer owns the anchor state or the Provider (Task 7: App does, since in
// Settings the light source lives in TopBar, a sibling of the scope). Tests that render
// DynamicScope directly now need to supply that ownership themselves, the same shape App.tsx
// uses, so the anchor-wiring behaviour below still exercises the real thing.
function Scoped({
  variant,
  children
}: {
  variant: DynamicVariant
  children: ReactNode
}): React.JSX.Element {
  // The real hook, not a hand-rolled pair of setters: the claim/release semantics it adds are the
  // whole point of the slot (see lib/ambientAnchors.ts), and a double without them would let this
  // suite pass over a regression it is supposed to catch.
  const { light, cutoff, anchors } = useAmbientAnchorState()
  return (
    <AmbientAnchorContext.Provider value={anchors}>
      <DynamicScope variant={variant} light={light} cutoff={cutoff}>
        {children}
      </DynamicScope>
    </AmbientAnchorContext.Provider>
  )
}

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
    <Scoped variant="case">
      <CaseWorkspace
        slug="NAV-1"
        activeMode={DEFAULT_MODE}
        caseTitle=""
        jiraKey={null}
        jiraSyncedAt={null}
        onModeSwitched={vi.fn()}
        onOpenHit={vi.fn()}
        onOpenCitation={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenRepoFile={vi.fn()}
      />
    </Scoped>
  )
}

/** Counts its own mounts so the remount assertion below is about mounting,
 *  not about re-rendering. */
function MountCounter(): React.JSX.Element {
  const [id] = useState(() => ++MountCounter.mounts)
  return <span data-testid="counter">{id}</span>
}
MountCounter.mounts = 0

describe('DynamicScope — case variant', () => {
  it('off: wrapper still renders, but with no scope class and no band', () => {
    render(
      <Scoped variant="case">
        <span>inner</span>
      </Scoped>
    )
    const root = screen.getByTestId('dynamic-case')
    expect(root.className).not.toContain('dyn-case')
    expect(screen.queryByTestId('ambient-fallback')).toBeNull()
    expect(screen.getByText('inner')).toBeTruthy()
  })

  it('on: scope class and band mount', () => {
    uiStore.setDynamicTheme(true)
    render(
      <Scoped variant="case">
        <span>inner</span>
      </Scoped>
    )
    const root = screen.getByTestId('dynamic-case')
    expect(root.className).toContain('dyn ')
    expect(root.className).toContain('dyn-case')
    expect(screen.getByTestId('ambient-fallback')).toBeTruthy()
  })

  it('carries the flex chain so the panes keep their height basis', () => {
    uiStore.setDynamicTheme(true)
    render(
      <Scoped variant="case">
        <span>inner</span>
      </Scoped>
    )
    const cls = screen.getByTestId('dynamic-case').className
    for (const c of ['flex', 'min-h-0', 'flex-1', 'flex-col']) expect(cls).toContain(c)
  })

  it('toggling does NOT remount the children', () => {
    MountCounter.mounts = 0
    render(
      <Scoped variant="case">
        <MountCounter />
      </Scoped>
    )
    expect(screen.getByTestId('counter').textContent).toBe('1')
    act(() => uiStore.setDynamicTheme(true))
    expect(screen.getByTestId('counter').textContent).toBe('1')
    act(() => uiStore.setDynamicTheme(false))
    expect(screen.getByTestId('counter').textContent).toBe('1')
  })

  it('paints no grain at all — grain is home-only', () => {
    uiStore.setDynamicTheme(true)
    render(
      <Scoped variant="case">
        <span>inner</span>
      </Scoped>
    )
    expect(document.querySelector('.dyn-grain')).toBeNull()
  })

  it('anchors the ambient band to its own element, not to a component box', async () => {
    renderWorkspace()
    await screen.findByRole('main')
    const band = document.querySelector('[data-testid="ambient-band"]')
    expect(band).not.toBeNull()
    // Inside the scope: AmbientCanvas measures anchors with `getBoundingClientRect`
    // (viewport-relative, see `anchorRect`), so nothing requires the cutoff to live inside
    // DynamicScope — this just documents where CaseWorkspace actually put it.
    expect(band?.closest('[data-testid="dynamic-case"]')).not.toBeNull()
    expect(band?.getAttribute('aria-hidden')).toBe('true')
  })

  it('wires the anchor refs to the ambient band, not just to some element', async () => {
    // The test above only checks that a `data-testid="ambient-band"` div exists somewhere in
    // the scope — it would stay green even if `ref={anchors.setCutoff}`/`setLight` were
    // deleted from CaseWorkspace and the aurora silently fell back to its hardcoded default.
    // This renders CaseWorkspace under a real AmbientAnchorContext.Provider (the same
    // `{ setLight, setCutoff }` shape `useAmbientAnchors` returns — see lib/ambientAnchors.ts)
    // and captures exactly which elements the ref callbacks receive.
    let cutoffEl: HTMLElement | null = null
    let lightEl: HTMLElement | null = null
    const anchors: AmbientAnchors = {
      setCutoff: (el) => {
        cutoffEl = el
        return () => {
          cutoffEl = null
        }
      },
      setLight: (el) => {
        lightEl = el
        return () => {
          lightEl = null
        }
      }
    }
    render(
      <AmbientAnchorContext.Provider value={anchors}>
        <CaseWorkspace
          slug="NAV-1"
          activeMode={DEFAULT_MODE}
          caseTitle=""
          jiraKey={null}
          jiraSyncedAt={null}
          onModeSwitched={vi.fn()}
          onOpenHit={vi.fn()}
          onOpenCitation={vi.fn()}
          onOpenFile={vi.fn()}
          onOpenRepoFile={vi.fn()}
        />
      </AmbientAnchorContext.Provider>
    )
    await screen.findByRole('main')
    const band = screen.getByTestId('ambient-band')
    expect(cutoffEl).toBe(band)
    expect(lightEl).not.toBeNull()
    expect(band.contains(lightEl)).toBe(true)
  })
})
