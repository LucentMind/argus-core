// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FindingsPane } from '../FindingsPane'
import { uiStore } from '../../lib/uiStore'

beforeEach(() => {
  localStorage.clear()
  uiStore.setFindingsCollapsed(false)
  window.argus = {
    cases: {
      readFindings: vi.fn(async () => '# Findings\n\n## Tile crash\nsee [evidence/log.txt:3]')
    },
    agent: { onEvent: vi.fn(() => () => undefined) },
    findings: {
      list: vi.fn(async () => []),
      review: vi.fn()
    }
  } as never
})

describe('FindingsPane', () => {
  it('renders findings markdown with citations', async () => {
    render(<FindingsPane slug="NAV-1" sessionId={1} onCite={vi.fn()} />)
    expect(await screen.findByText('Tile crash')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'evidence/log.txt:3' })).toBeTruthy()
  })

  it('collapse button collapses the pane via the ui store', () => {
    render(<FindingsPane slug="NAV-1" sessionId={1} onCite={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse findings' }))
    expect(uiStore.get().findingsCollapsed).toBe(true)
  })

  it('lists findings with accept/reject and calls review', async () => {
    const review = vi.fn().mockResolvedValue({ id: 1, reviewState: 'accepted' })
    ;(window.argus as unknown as { findings: unknown }).findings = {
      list: vi.fn().mockResolvedValue([{ id: 1, summary: 'Root cause X', reviewState: 'pending' }]),
      review
    }
    ;(window.argus.cases as unknown as { readFindings: unknown }).readFindings = vi
      .fn()
      .mockResolvedValue('# Findings')
    render(<FindingsPane slug="c1" sessionId={1} onCite={() => {}} />)
    const accept = await screen.findByRole('button', { name: /accept finding/i })
    accept.click()
    expect(review).toHaveBeenCalledWith(1, 'accepted')
  })
})
