// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FindingsPane } from '../FindingsPane'
import { uiStore } from '../../lib/uiStore'
import { clearSnippetCache } from '../../lib/snippetCache'

beforeEach(() => {
  localStorage.clear()
  clearSnippetCache()
  uiStore.setFindingsCollapsed(false)
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
      list: vi.fn(async () => []),
      review: vi.fn(),
      clear: vi.fn(async () => ({ cleared: 1 }))
    },
    workspaces: { list: vi.fn(async () => []), refs: vi.fn(async () => []) }
  } as never
})

describe('FindingsPane', () => {
  it('expands a finding to show its body with auto-expanded citation cards', async () => {
    ;(window.argus.findings as unknown as { list: unknown }).list = vi.fn(async () => [
      {
        id: 1,
        summary: 'Tile crash',
        reviewState: 'pending',
        sessionId: 4,
        body: 'see [evidence/log.txt:3]'
      }
    ])
    render(<FindingsPane slug="NAV-1" sessionId={1} onCite={vi.fn()} />)
    // body is collapsed until the summary is clicked
    const summary = await screen.findByText('Tile crash')
    expect(screen.queryByRole('button', { name: /log\.txt:3/ })).toBeNull()
    summary.click()
    // citation renders as a chip that is ALREADY expanded (findings default)
    const chip = await screen.findByRole('button', { name: /log\.txt:3/ })
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    // and the snippet preview around line 3 is visible without any further click
    expect(await screen.findByText('boom')).toBeTruthy()
  })

  it('collapse button collapses the pane via the ui store', () => {
    render(<FindingsPane slug="NAV-1" sessionId={1} onCite={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse findings' }))
    expect(uiStore.get().findingsCollapsed).toBe(true)
  })

  it('thumbs-up marks a pending finding accepted', async () => {
    const review = vi.fn().mockResolvedValue({ id: 1, reviewState: 'accepted' })
    ;(window.argus.findings as unknown as { list: unknown; review: unknown }).list = vi.fn(
      async () => [{ id: 1, summary: 'Root cause X', reviewState: 'pending', sessionId: 4 }]
    )
    ;(window.argus.findings as unknown as { review: unknown }).review = review
    render(<FindingsPane slug="c1" sessionId={1} onCite={() => {}} />)
    const good = await screen.findByRole('button', { name: /mark finding good/i })
    good.click()
    expect(review).toHaveBeenCalledWith(1, 'accepted')
  })

  it('clicking the active thumb toggles the finding back to pending', async () => {
    const review = vi.fn().mockResolvedValue({ id: 1, reviewState: 'pending' })
    ;(window.argus.findings as unknown as { list: unknown }).list = vi.fn(async () => [
      { id: 1, summary: 'Root cause X', reviewState: 'accepted', sessionId: 4 }
    ])
    ;(window.argus.findings as unknown as { review: unknown }).review = review
    render(<FindingsPane slug="c1" sessionId={1} onCite={() => {}} />)
    const good = await screen.findByRole('button', { name: /mark finding good/i })
    good.click()
    expect(review).toHaveBeenCalledWith(1, 'pending')
  })

  it('Clear findings confirms, calls clear, and refetches', async () => {
    window.confirm = vi.fn(() => true)
    const list = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 1, summary: 'Root cause X', reviewState: 'pending', sessionId: 4 }
      ])
      .mockResolvedValue([])
    ;(window.argus.findings as unknown as { list: unknown }).list = list
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
    const list = vi.fn(async () => [
      { id: 1, summary: 'Root cause X', reviewState: 'pending', sessionId: 4 }
    ])
    const clear = vi.fn(async () => {
      throw new Error('fs busy')
    })
    ;(window.argus.findings as unknown as { list: unknown; clear: unknown }).list = list
    ;(window.argus.findings as unknown as { clear: unknown }).clear = clear
    render(<FindingsPane slug="NAV-1" sessionId={1} onCite={vi.fn()} />)
    await screen.findByText('Root cause X')
    fireEvent.click(screen.getByRole('button', { name: 'Clear findings' }))
    expect(await screen.findByText('fs busy')).toBeTruthy()
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('no clear button when there is nothing to clear', async () => {
    ;(window.argus.cases as unknown as { readFindings: unknown }).readFindings = vi.fn(
      async () => ''
    )
    render(<FindingsPane slug="NAV-1" sessionId={1} onCite={vi.fn()} />)
    expect(await screen.findByText('No findings yet.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Clear findings' })).toBeNull()
  })
})
