// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaseWorkspace } from '../CaseWorkspace'
import { uiStore } from '../../lib/uiStore'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import type { CaseResolution, CaseStatus } from '../../../../shared/types'

// jsdom has no runtime ResizeObserver; DOM lib types already declare it globally.
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
  uiStore.setFindingsCollapsed(false)
  uiStore.setFindingsWidth(384)
  // CaseWorkspace renders Composer, which reads the shared settingsStore
  // singleton — reset it so state doesn't leak across tests.
  settingsStore.reset()
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
    cases: { readFindings: vi.fn(async () => ''), setStatus: vi.fn(async () => undefined) },
    distill: {
      status: vi.fn(async () => null),
      retry: vi.fn(),
      redistill: vi.fn(),
      similar: vi.fn(async () => []),
      onChanged: vi.fn(() => () => undefined)
    },
    findings: {
      list: vi.fn(async () => []),
      review: vi.fn()
    },
    evidence: {
      list: vi.fn(async () => []),
      ingest: vi.fn(async () => []),
      onChanged: vi.fn(() => () => {}),
      onParsing: vi.fn(() => () => {})
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
      decls: vi.fn(async () => [
        {
          packId: 'sample-pack',
          windowId: 'text-viewer',
          title: 'Text Viewer',
          handles: ['logcat']
        }
      ]),
      open: vi.fn(async () => ({
        caseSlug: 'CASE-1',
        packId: 'sample-pack',
        windowId: 'text-viewer',
        title: 'Text Viewer',
        floated: false
      })),
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

function workspace(
  slug: string,
  overrides?: {
    status?: CaseStatus
    resolution?: CaseResolution | null
    onStatusChanged?: () => void
  }
): React.JSX.Element {
  return (
    <CaseWorkspace
      slug={slug}
      jiraKey={null}
      jiraSyncedAt={null}
      status={overrides?.status ?? 'open'}
      resolution={overrides?.resolution ?? null}
      onStatusChanged={overrides?.onStatusChanged ?? vi.fn()}
      onOpenHit={vi.fn()}
      onOpenCitation={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenRepoFile={vi.fn()}
    />
  )
}

function renderWorkspace(overrides?: {
  status?: CaseStatus
  resolution?: CaseResolution | null
  onStatusChanged?: () => void
}): ReturnType<typeof render> {
  return render(workspace('NAV-1', overrides))
}

// CaseFiles is evidence-only: the Analyze button comes from evidence.list, not files.list
function stubAnalyzableFile(): void {
  window.argus.evidence.list = vi.fn(async () => [
    {
      id: 1,
      caseId: 1,
      relPath: 'evidence/trace.binlog',
      sha256: 'x',
      artifactType: 'binlog',
      size: 10,
      origin: 'upload',
      meta: {},
      createdAt: '2026-03-14T09:32:00.000Z'
    }
  ]) as never
}

describe('CaseWorkspace composer prefill', () => {
  it('clears an Analyze prefill when switching to another case', async () => {
    stubAnalyzableFile()
    const view = renderWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /analyze/i }))
    const box = screen.getByPlaceholderText<HTMLTextAreaElement>(
      'Message the analyst — / for skills'
    )
    expect(box.value).toBe('/analyze-binlog evidence/trace.binlog')
    // switching tabs rerenders with the new slug — case A's suggestion must not leak into case B.
    // ChatPane briefly unmounts while the new case's session id loads (Task 5 bridge), so
    // await its remount rather than querying synchronously.
    view.rerender(workspace('NAV-2'))
    const boxAfter = await screen.findByPlaceholderText<HTMLTextAreaElement>(
      'Message the analyst — / for skills'
    )
    expect(boxAfter.value).toBe('')
  })

  it('Analyze works in the new case even for an identical suggestion string', async () => {
    // both cases hold an identically-named file, so both suggest the same text; the
    // stale prefill from case A must not swallow case B's click as a state no-op
    stubAnalyzableFile()
    const view = renderWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /analyze/i }))
    view.rerender(workspace('NAV-2'))
    fireEvent.click(await screen.findByRole('button', { name: /analyze/i }))
    const box = await screen.findByPlaceholderText<HTMLTextAreaElement>(
      'Message the analyst — / for skills'
    )
    expect(box.value).toBe('/analyze-binlog evidence/trace.binlog')
  })
})

describe('CaseWorkspace case switching', () => {
  it('remounts CaseFiles on slug change so per-case state (type filter) resets', async () => {
    const { rerender } = render(workspace('NAV-1'))
    const select = (await screen.findByLabelText('type-filter')) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'binlog' } })
    expect(select.value).toBe('binlog')
    // switching tabs must not leak case A's filter/collapse/parsing state into case B
    rerender(workspace('NAV-2'))
    expect((screen.getByLabelText('type-filter') as HTMLSelectElement).value).toBe('')
  })
})

describe('CaseWorkspace session bootstrap', () => {
  it('shows an inline error when sessions.list rejects, without crashing', async () => {
    window.argus.sessions.list = vi.fn(async () => {
      throw new Error('boom')
    })
    renderWorkspace()
    expect(await screen.findByText('Could not load chat sessions.')).toBeTruthy()
  })
})

describe('CaseWorkspace findings pane', () => {
  it('drag on the separator resizes the pane (leftwards widens)', () => {
    renderWorkspace()
    const sep = screen.getByRole('separator', { name: 'Resize findings pane' })
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 1000 })
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 900 })
    expect(uiStore.get().findingsWidth).toBe(484)
    fireEvent.pointerUp(sep, { pointerId: 1 })
    // after release, further moves change nothing
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 500 })
    expect(uiStore.get().findingsWidth).toBe(484)
  })

  it('collapse hides the pane and the edge button expands it back', async () => {
    renderWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse findings' }))
    expect(screen.queryByRole('separator', { name: 'Resize findings pane' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand findings' }))
    expect(uiStore.get().findingsCollapsed).toBe(false)
    expect(screen.getByRole('separator', { name: 'Resize findings pane' })).toBeTruthy()
  })
})

describe('CaseWorkspace panel tab host', () => {
  it('shows a Chat tab and lists available panels in the launcher', async () => {
    renderWorkspace()
    expect(await screen.findByText('Chat')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Open panel'))
    expect(await screen.findByText('Text Viewer')).toBeTruthy()
  })
})

describe('CaseWorkspace case-id menu', () => {
  it('closes the case as duplicate via the Close as… submenu', async () => {
    const setStatus = vi.fn().mockResolvedValue(undefined)
    window.argus.cases.setStatus = setStatus
    const onStatusChanged = vi.fn()
    renderWorkspace({ status: 'open', resolution: null, onStatusChanged })
    // case id opens the menu; "Close as…" expands its submenu; then pick a resolution
    fireEvent.click(screen.getByRole('button', { name: 'NAV-1' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /close as/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'duplicate' }))
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith('NAV-1', 'closed', 'duplicate'))
    expect(onStatusChanged).toHaveBeenCalled()
  })

  it('shows Reopen and the resolution label when the case is closed', async () => {
    const setStatus = vi.fn().mockResolvedValue(undefined)
    window.argus.cases.setStatus = setStatus
    const onStatusChanged = vi.fn()
    renderWorkspace({ status: 'closed', resolution: 'wont-fix', onStatusChanged })
    fireEvent.click(screen.getByRole('button', { name: 'NAV-1' }))
    // the closed status still reads on the submenu parent
    fireEvent.click(screen.getByRole('menuitem', { name: /closed · wont-fix/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reopen' }))
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith('NAV-1', 'open', null))
    expect(onStatusChanged).toHaveBeenCalled()
  })

  it('shows a bare "Closed" label (not "Close as…") for a legacy closed case with no resolution', async () => {
    renderWorkspace({ status: 'closed', resolution: null })
    fireEvent.click(screen.getByRole('button', { name: 'NAV-1' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Closed' }))
    expect(screen.getByRole('menuitem', { name: 'Reopen' })).toBeTruthy()
  })

  it('exports the case via the Export submenu', async () => {
    const exportFn = vi.fn().mockResolvedValue({ ok: true, fileCount: 3 })
    window.argus.bundle = { export: exportFn } as never
    renderWorkspace({ status: 'open', resolution: null })
    fireEvent.click(screen.getByRole('button', { name: 'NAV-1' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export case…' }))
    await waitFor(() => expect(exportFn).toHaveBeenCalledWith('NAV-1', true))
    expect(await screen.findByText(/exported 3 files/i)).toBeTruthy()
  })
})
