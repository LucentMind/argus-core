// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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
      review: vi.fn(),
      clear: vi.fn(async () => ({ cleared: 1 }))
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

  it('Clear findings confirms, calls clear, and refetches', async () => {
    window.confirm = vi.fn(() => true)
    const list = vi
      .fn()
      .mockResolvedValueOnce([{ id: 1, summary: 'Root cause X', reviewState: 'pending' }])
      .mockResolvedValue([])
    const readFindings = vi
      .fn()
      .mockResolvedValueOnce('# Findings\n\n## Root cause X\nbody')
      .mockResolvedValue('# Findings — NAV-1\n')
    ;(window.argus as unknown as { findings: unknown }).findings = {
      list,
      review: vi.fn(),
      clear: vi.fn(async () => ({ cleared: 1 }))
    }
    ;(window.argus.cases as unknown as { readFindings: unknown }).readFindings = readFindings

    render(<FindingsPane slug="NAV-1" sessionId={1} onCite={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Clear findings' }))
    expect(window.confirm).toHaveBeenCalledWith(
      'Clear all findings for this case? 1 finding and findings.md are reset.'
    )
    await waitFor(() =>
      expect(
        (window.argus.findings as unknown as { clear: ReturnType<typeof vi.fn> }).clear
      ).toHaveBeenCalledWith('NAV-1')
    )
    expect(await screen.findByText('No findings yet.')).toBeTruthy()
  })

  it('shows an inline error and still refetches when clear rejects', async () => {
    window.confirm = vi.fn(() => true)
    const findingRow = { id: 1, summary: 'Root cause X', reviewState: 'pending' }
    const list = vi.fn(async () => [findingRow])
    const readFindings = vi.fn(async () => '# Findings\n\n## Root cause X\nbody')
    const clear = vi.fn(async () => {
      throw new Error('fs busy')
    })
    ;(window.argus as unknown as { findings: unknown }).findings = { list, review: vi.fn(), clear }
    ;(window.argus.cases as unknown as { readFindings: unknown }).readFindings = readFindings

    render(<FindingsPane slug="NAV-1" sessionId={1} onCite={vi.fn()} />)
    // "Root cause X" renders twice (finding row + markdown heading) — wait on the
    // review-state text, which is unique to the finding row
    await screen.findByText('pending')
    fireEvent.click(screen.getByRole('button', { name: 'Clear findings' }))
    expect(await screen.findByText('fs busy')).toBeTruthy()
    // initial mount fetch + the finally-block refetch after the failed clear
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(readFindings).toHaveBeenCalledTimes(2))
  })

  it('no clear button when there is nothing to clear', async () => {
    ;(window.argus.cases as unknown as { readFindings: unknown }).readFindings = vi
      .fn()
      .mockResolvedValue('')
    render(<FindingsPane slug="NAV-1" sessionId={1} onCite={vi.fn()} />)
    expect(await screen.findByText('No findings yet.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Clear findings' })).toBeNull()
  })
})
