// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaseWorkspace } from '../CaseWorkspace'
import { uiStore } from '../../lib/uiStore'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'

function payload(): SettingsPayload {
  return {
    settings: defaultSettings(),
    resolvedTools: {
      traceDir: { value: null, source: 'default' },
      parseBin: { value: null, source: 'default' }
    },
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
      authStatus: vi.fn(async () => ({ ok: true, detail: 'ready' })),
      preflight: vi.fn(async () => ({ ok: true, checks: [] }))
    },
    cases: { readFindings: vi.fn(async () => '') },
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
    pathForFile: vi.fn(),
    workspaces: { list: vi.fn(async () => []), refs: vi.fn(async () => []) },
    skills: { list: vi.fn(async () => ({ skills: [] })) },
    search: { query: vi.fn(async () => []) },
    settings: {
      get: vi.fn(async () => payload()),
      patch: vi.fn(async () => payload()),
      reveal: vi.fn(),
      onChanged: vi.fn(() => () => {})
    }
  } as never
})

function workspace(slug: string): React.JSX.Element {
  return (
    <CaseWorkspace
      slug={slug}
      jiraKey={null}
      jiraSyncedAt={null}
      onOpenHit={vi.fn()}
      onOpenCitation={vi.fn()}
      onOpenFile={vi.fn()}
    />
  )
}

function renderWorkspace(): ReturnType<typeof render> {
  return render(workspace('NAV-1'))
}

// post-WP-B the Analyze button is rendered by CaseFiles from files.list (not evidence.list)
function stubAnalyzableFile(): void {
  window.argus.files.list = vi.fn(async () => [
    {
      name: 'evidence',
      relPath: 'evidence',
      kind: 'dir',
      size: 0,
      children: [
        {
          name: 'trace.binlog',
          relPath: 'evidence/trace.binlog',
          kind: 'file',
          size: 10,
          evidence: { id: 1, artifactType: 'binlog', derived: false }
        }
      ]
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
    // switching tabs rerenders with the new slug — case A's suggestion must not leak into case B
    view.rerender(workspace('NAV-2'))
    const boxAfter = screen.getByPlaceholderText<HTMLTextAreaElement>(
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
    const box = screen.getByPlaceholderText<HTMLTextAreaElement>(
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
