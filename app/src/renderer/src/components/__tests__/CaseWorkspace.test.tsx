// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaseWorkspace } from '../CaseWorkspace'
import { uiStore } from '../../lib/uiStore'

beforeEach(() => {
  localStorage.clear()
  uiStore.setFindingsCollapsed(false)
  uiStore.setFindingsWidth(384)
  window.argus = {
    agent: {
      history: vi.fn(async () => []),
      onEvent: vi.fn(() => () => undefined),
      send: vi.fn(),
      authStatus: vi.fn(async () => ({ ok: true, detail: 'ready' })),
      preflight: vi.fn(async () => ({ ok: true, checks: [] }))
    },
    cases: { readFindings: vi.fn(async () => '') },
    evidence: { list: vi.fn(async () => []) },
    workspaces: { list: vi.fn(async () => []) },
    skills: { list: vi.fn(async () => []) },
    search: { query: vi.fn(async () => []) }
  } as never
})

function renderWorkspace(): void {
  render(<CaseWorkspace slug="NAV-1" onOpenHit={vi.fn()} onOpenCitation={vi.fn()} />)
}

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
