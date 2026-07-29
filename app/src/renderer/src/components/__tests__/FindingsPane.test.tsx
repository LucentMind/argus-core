// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FindingsPane } from '../FindingsPane'
import { uiStore } from '../../lib/uiStore'
import { clearSnippetCache } from '../../lib/snippetCache'
import { confirm } from '../../lib/confirmStore'
import type { FindingRow } from '../../../../shared/observability'

vi.mock('../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

function row(over: Partial<FindingRow>): FindingRow {
  return {
    id: 1,
    caseId: 1,
    sessionId: 1,
    turnId: null,
    summary: 's',
    reviewState: 'pending',
    reviewedAt: null,
    createdAt: '2026-07-27T10:00:00.000Z',
    layer: null,
    severity: null,
    diffPath: null,
    diffLine: null,
    suggestedChange: null,
    commentUrl: null,
    pushedSha: null,
    mode: 'investigation',
    ...over
  }
}

const list = vi.fn()

beforeEach(() => {
  localStorage.clear()
  clearSnippetCache()
  uiStore.setFindingsCollapsed(false)
  list.mockReset()
  list.mockResolvedValue([])
  window.argus = {
    cases: { readFindings: vi.fn(async () => '# Findings — NAV-1\n') },
    agent: { onEvent: vi.fn(() => () => undefined) },
    evidence: {
      readSnippet: vi.fn(async () => ({
        ok: true,
        evidenceId: 3,
        relPath: 'evidence/log.txt',
        startLine: 1,
        lines: ['a', 'b', 'boom'],
        lang: null,
        eof: false
      })),
      onChanged: vi.fn(() => () => undefined)
    },
    findings: {
      list,
      review: vi.fn(),
      clear: vi.fn(async () => ({ cleared: 1 }))
    },
    workspaces: { list: vi.fn(async () => []), refs: vi.fn(async () => []) },
    review: { worktreeHead: vi.fn(async () => null) }
  } as never
})

describe('FindingsPane', () => {
  it('expands a finding to show its body with citation cards collapsed until clicked', async () => {
    ;(window.argus.findings as unknown as { list: unknown }).list = vi.fn(async () => [
      {
        id: 1,
        summary: 'Tile crash',
        reviewState: 'pending',
        sessionId: 4,
        mode: 'investigation',
        body: 'see [evidence/log.txt:3]'
      }
    ])
    render(<FindingsPane slug="NAV-1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    // body is collapsed until the summary is clicked
    const summary = await screen.findByText('Tile crash')
    expect(screen.queryByRole('button', { name: /log\.txt:3/ })).toBeNull()
    summary.click()
    // the citation renders as a chip that starts COLLAPSED — a finding often carries several
    // citations, and auto-expanding every preview buried the finding text (changed 2026-07-29
    // on owner feedback; it used to auto-expand)
    const chip = await screen.findByRole('button', { name: /log\.txt:3/ })
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('boom')).toBeNull()
    // clicking the chip opens the snippet preview
    fireEvent.click(chip)
    expect(await screen.findByText('boom')).toBeTruthy()
  })

  it('collapse button collapses the pane via the ui store', () => {
    render(<FindingsPane slug="NAV-1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse findings' }))
    expect(uiStore.get().findingsCollapsed).toBe(true)
  })

  it('thumbs-up marks a pending finding accepted', async () => {
    const review = vi.fn().mockResolvedValue({ id: 1, reviewState: 'accepted' })
    ;(window.argus.findings as unknown as { list: unknown; review: unknown }).list = vi.fn(
      async () => [
        {
          id: 1,
          summary: 'Root cause X',
          reviewState: 'pending',
          sessionId: 4,
          mode: 'investigation'
        }
      ]
    )
    ;(window.argus.findings as unknown as { review: unknown }).review = review
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={() => {}} />)
    const good = await screen.findByRole('button', { name: /mark finding good/i })
    good.click()
    expect(review).toHaveBeenCalledWith(1, 'accepted')
  })

  it('clicking the active thumb toggles the finding back to pending', async () => {
    const review = vi.fn().mockResolvedValue({ id: 1, reviewState: 'pending' })
    ;(window.argus.findings as unknown as { list: unknown }).list = vi.fn(async () => [
      {
        id: 1,
        summary: 'Root cause X',
        reviewState: 'accepted',
        sessionId: 4,
        mode: 'investigation'
      }
    ])
    ;(window.argus.findings as unknown as { review: unknown }).review = review
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={() => {}} />)
    const good = await screen.findByRole('button', { name: /mark finding good/i })
    good.click()
    expect(review).toHaveBeenCalledWith(1, 'pending')
  })

  it('Clear findings confirms, calls clear, and refetches', async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    const list = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 1,
          summary: 'Root cause X',
          reviewState: 'pending',
          sessionId: 4,
          mode: 'investigation'
        }
      ])
      .mockResolvedValue([])
    ;(window.argus.findings as unknown as { list: unknown }).list = list
    render(<FindingsPane slug="NAV-1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Clear findings' }))
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Clear all investigation findings for this case?',
        message:
          '1 finding and the matching findings.md sections are removed. Review findings are untouched.'
      })
    )
    await waitFor(() =>
      expect(
        (window.argus.findings as unknown as { clear: ReturnType<typeof vi.fn> }).clear
      ).toHaveBeenCalledWith('NAV-1', 'investigation')
    )
    expect(await screen.findByText('No findings yet.')).toBeTruthy()
  })

  it('shows an inline error and still refetches when clear rejects', async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    const list = vi.fn(async () => [
      {
        id: 1,
        summary: 'Root cause X',
        reviewState: 'pending',
        sessionId: 4,
        mode: 'investigation'
      }
    ])
    const clear = vi.fn(async () => {
      throw new Error('fs busy')
    })
    ;(window.argus.findings as unknown as { list: unknown; clear: unknown }).list = list
    ;(window.argus.findings as unknown as { clear: unknown }).clear = clear
    render(<FindingsPane slug="NAV-1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    await screen.findByText('Root cause X')
    fireEvent.click(screen.getByRole('button', { name: 'Clear findings' }))
    expect(await screen.findByText('fs busy')).toBeTruthy()
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('no clear button when there is nothing to clear', async () => {
    ;(window.argus.cases as unknown as { readFindings: unknown }).readFindings = vi.fn(
      async () => ''
    )
    render(<FindingsPane slug="NAV-1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    expect(await screen.findByText('No findings yet.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Clear findings' })).toBeNull()
  })

  describe('mode scoping', () => {
    it('shows only findings of the active mode, and counts only them', async () => {
      list.mockResolvedValue([
        row({ id: 1, summary: 'review finding', mode: 'review' }),
        row({ id: 2, summary: 'triage finding', mode: 'investigation' })
      ])
      const view = render(
        <FindingsPane slug="c1" sessionId={1} activeMode="review" onCite={vi.fn()} />
      )
      expect(await screen.findByText('review finding')).toBeInTheDocument()
      expect(screen.queryByText('triage finding')).not.toBeInTheDocument()
      expect(screen.getByText('Findings · 1')).toBeInTheDocument()

      view.rerender(
        <FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />
      )
      expect(await screen.findByText('triage finding')).toBeInTheDocument()
      expect(screen.queryByText('review finding')).not.toBeInTheDocument()
    })

    it('clear-all names the mode and passes it to the IPC call', async () => {
      list.mockResolvedValue([row({ id: 1, summary: 'review finding', mode: 'review' })])
      render(<FindingsPane slug="c1" sessionId={1} activeMode="review" onCite={vi.fn()} />)
      await screen.findByText('review finding')
      await userEvent.click(screen.getByRole('button', { name: 'Clear findings' }))
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Clear all review findings for this case?' })
      )
      expect(window.argus.findings.clear).toHaveBeenCalledWith('c1', 'review')
    })

    it('shows no clear button when the active mode has no findings, even if the other mode does', async () => {
      list.mockResolvedValue([row({ id: 1, summary: 'triage finding', mode: 'investigation' })])
      render(<FindingsPane slug="c1" sessionId={1} activeMode="review" onCite={vi.fn()} />)
      await screen.findByText('No findings yet.')
      expect(screen.queryByRole('button', { name: 'Clear findings' })).not.toBeInTheDocument()
    })

    it('keeps the header and filter chips outside the scrolling list region', async () => {
      list.mockResolvedValue([row({ id: 1, summary: 'scrolls away' })])
      const { container } = render(
        <FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />
      )
      await screen.findByText('scrolls away')
      const scroller = container.querySelector('.overflow-y-auto')
      expect(scroller).not.toBeNull()
      expect(scroller!.contains(screen.getByText('scrolls away'))).toBe(true)
      expect(scroller!.contains(screen.getByText(/Findings · 1/))).toBe(false)
    })
  })
})
