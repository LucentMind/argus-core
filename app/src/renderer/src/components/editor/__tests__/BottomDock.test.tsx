// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { BottomDock } from '../BottomDock'
import type { ValidationIssue } from '../../../../../shared/assetValidation'
import type { ReferenceHit } from '../../../../../shared/corpusSearch'

const ISSUES: ValidationIssue[] = [{ severity: 'error', message: 'Boom', line: 3 }]
const HITS: ReferenceHit[] = [
  { kind: 'skill', name: 'triage', line: 7, text: 'read jira-fields.md' }
]

const base = {
  issues: [] as ValidationIssue[],
  references: null as { query: string; hits: ReferenceHit[] } | null,
  searching: false,
  open: true,
  tab: 'problems' as const,
  onOpenChange: vi.fn(),
  onTabChange: vi.fn(),
  onGoToLine: vi.fn(),
  onOpenHit: vi.fn(),
  onDismissReferences: vi.fn()
}

// Finding 9: these mocks are shared, module-scope objects across every test in this file — left
// un-reset, a later assertion like `toHaveBeenCalledWith(true)` passes whether THIS test caused
// the call or an earlier one did, and only happened to be true because of the file's run order.
beforeEach(() => {
  vi.clearAllMocks()
})

describe('BottomDock', () => {
  it('renders nothing when there is neither a problem nor a search', () => {
    const { container } = render(<BottomDock {...base} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows only the Problems tab when there is no search', () => {
    render(<BottomDock {...base} issues={ISSUES} />)
    expect(screen.getByRole('tab', { name: /problem/i })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: /reference/i })).toBeNull()
  })

  it('shows the References tab and its hits when that is the selected tab', () => {
    render(
      <BottomDock
        {...base}
        tab="references"
        issues={ISSUES}
        references={{ query: 'jira-fields.md', hits: HITS }}
      />
    )
    expect(screen.getByRole('tab', { name: /reference/i }).getAttribute('aria-selected')).toBe(
      'true'
    )
    expect(screen.getByText(/read jira-fields.md/)).toBeTruthy()
  })

  it('reports a count, and says so when there are none', () => {
    render(<BottomDock {...base} tab="references" references={{ query: 'x.md', hits: [] }} />)
    expect(screen.getByText(/nothing mentions/i)).toBeTruthy()
  })

  it('says it is searching', () => {
    render(<BottomDock {...base} tab="references" searching references={null} />)
    expect(screen.getByText(/searching/i)).toBeTruthy()
  })

  it('opens the asset a hit is in', () => {
    const onOpenHit = vi.fn()
    render(
      <BottomDock
        {...base}
        tab="references"
        references={{ query: 'x.md', hits: HITS }}
        onOpenHit={onOpenHit}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /triage/ }))
    expect(onOpenHit).toHaveBeenCalledWith(HITS[0])
  })

  it('jumps to a problem line', () => {
    const onGoToLine = vi.fn()
    render(<BottomDock {...base} issues={ISSUES} onGoToLine={onGoToLine} />)
    fireEvent.click(screen.getByRole('button', { name: /boom/i }))
    expect(onGoToLine).toHaveBeenCalledWith(3)
  })

  it('renders no body when collapsed, and asks its owner to expand', () => {
    render(<BottomDock {...base} open={false} issues={ISSUES} />)
    expect(screen.queryByRole('button', { name: /boom/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    expect(base.onOpenChange).toHaveBeenCalledWith(true)
  })

  it('selects a tab through its owner rather than locally', () => {
    const onTabChange = vi.fn()
    render(
      <BottomDock
        {...base}
        issues={ISSUES}
        references={{ query: 'x.md', hits: HITS }}
        onTabChange={onTabChange}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /reference/i }))
    expect(onTabChange).toHaveBeenCalledWith('references')
  })

  it('drops the search from the strip when it is dismissed', () => {
    const onDismissReferences = vi.fn()
    render(
      <BottomDock
        {...base}
        references={{ query: 'x.md', hits: HITS }}
        onDismissReferences={onDismissReferences}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /clear/i }))
    expect(onDismissReferences).toHaveBeenCalledOnce()
  })

  // Moved from ProblemsPanel.test.tsx: the collapse toggle and the "N problems" summary used to
  // be ProblemsPanel's own chrome; both now live on the dock's tab strip, which stays visible
  // while collapsed — only the list body disappears.
  it('summarises the counts while collapsed and lists nothing', () => {
    render(<BottomDock {...base} open={false} issues={ISSUES} />)
    expect(screen.getByRole('tab', { name: /problem/i })).toBeTruthy()
    expect(screen.queryByText('Boom')).toBeNull()
  })

  it('singularises one error in the tab strip', () => {
    render(<BottomDock {...base} issues={[{ severity: 'error', message: 'x', line: 1 }]} />)
    expect(screen.getByRole('tab', { name: /problem/i }).textContent).toBe('1 error')
  })
})
