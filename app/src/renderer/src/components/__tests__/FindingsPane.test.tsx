// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FindingsPane } from '../FindingsPane'
import { uiStore } from '../../lib/uiStore'
import { clearSnippetCache } from '../../lib/snippetCache'
import { confirm } from '../../lib/confirmStore'
import { reposStore } from '../../lib/reposStore'
import { agentStore } from '../../lib/agentStore'
import type { FindingRow } from '../../../../shared/observability'
import type { AgentEvent } from '../../../../shared/agent-events'

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
    commentBody: null,
    headSha: null,
    mode: 'investigation',
    ...over
  }
}

const list = vi.fn()

beforeEach(() => {
  localStorage.clear()
  clearSnippetCache()
  reposStore.clearForTests()
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
    workspaces: {
      list: vi.fn(async () => []),
      refs: vi.fn(async () => []),
      readSnippet: vi.fn(async () => ({
        ok: true,
        repoName: 'widget',
        relPath: 'src/foo.ts',
        startLine: 1,
        lines: ['a', 'b', 'c'],
        lang: null,
        eof: false,
        truncated: false,
        ref: 'main'
      }))
    },
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

  // Finding 2 (final-review hardening): a repo citation preview must only be pinned to
  // `head_sha` for a REVIEW-mode finding. An investigation finding bound to a PR-bound case
  // still gets a best-effort headSha stamp (nativeTools.ts), but pinning its preview would
  // render `git show <head>:path` content its author never read, with no "code moved" chip to
  // flag it — the citation must fall through to the live worktree instead.
  it('pins a repo citation preview to headSha only for a review-mode finding', async () => {
    ;(window.argus.workspaces as unknown as { list: unknown }).list = vi.fn(async () => [
      { path: 'widget', remote: null }
    ])
    await reposStore.load('c1')
    ;(window.argus.findings as unknown as { list: unknown }).list = vi.fn(async () => [
      {
        id: 1,
        summary: 'Review finding',
        reviewState: 'pending',
        sessionId: 4,
        mode: 'review',
        headSha: 'deadbeefcafe',
        body: 'see [widget/src/foo.ts:5]'
      }
    ])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="review" onCite={vi.fn()} />)
    const summary = await screen.findByText('Review finding')
    summary.click()
    const chip = await screen.findByRole('button', { name: /foo\.ts:5/ })
    fireEvent.click(chip)
    await waitFor(() => {
      const readSnippet = (
        window.argus.workspaces as unknown as { readSnippet: ReturnType<typeof vi.fn> }
      ).readSnippet
      expect(readSnippet).toHaveBeenCalledWith('c1', 'widget', 'src/foo.ts', 5, 5, 'deadbeefcafe')
    })
  })

  it('does not pin a repo citation preview for a non-review finding even with headSha set', async () => {
    ;(window.argus.workspaces as unknown as { list: unknown }).list = vi.fn(async () => [
      { path: 'widget', remote: null }
    ])
    await reposStore.load('c1')
    ;(window.argus.findings as unknown as { list: unknown }).list = vi.fn(async () => [
      {
        id: 1,
        summary: 'Investigation finding',
        reviewState: 'pending',
        sessionId: 4,
        mode: 'investigation',
        headSha: 'deadbeefcafe',
        body: 'see [widget/src/foo.ts:5]'
      }
    ])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    const summary = await screen.findByText('Investigation finding')
    summary.click()
    const chip = await screen.findByRole('button', { name: /foo\.ts:5/ })
    fireEvent.click(chip)
    await waitFor(() => {
      const readSnippet = (
        window.argus.workspaces as unknown as { readSnippet: ReturnType<typeof vi.fn> }
      ).readSnippet
      expect(readSnippet).toHaveBeenCalledWith('c1', 'widget', 'src/foo.ts', 5, 5)
    })
    const readSnippet = (
      window.argus.workspaces as unknown as { readSnippet: ReturnType<typeof vi.fn> }
    ).readSnippet
    expect(readSnippet.mock.calls[0]).toHaveLength(5)
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

  it('separates the destructive header control from the benign one', async () => {
    ;(window.argus.findings as unknown as { list: unknown }).list = vi.fn(async () => [
      {
        id: 1,
        summary: 'Root cause X',
        reviewState: 'pending',
        sessionId: 4,
        mode: 'investigation'
      }
    ])
    render(<FindingsPane slug="NAV-1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    const clear = await screen.findByRole('button', { name: 'Clear findings' })
    const collapse = screen.getByRole('button', { name: 'Collapse findings' })
    const cluster = clear.parentElement as HTMLElement
    expect(cluster.contains(collapse)).toBe(true)
    // A rule between them — the one control here with consequences reads as separate.
    // Queried by testid, not by [aria-hidden]: lucide-react stamps aria-hidden="true" on every
    // icon svg it renders (lucide-react.js:92), so an attribute query matches the Trash2 glyph
    // inside the clear button first.
    const rule = screen.getByTestId('clear-rule')
    expect(clear.compareDocumentPosition(rule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(rule.compareDocumentPosition(collapse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps the last-loaded findings on screen when a bump-triggered refetch rejects', async () => {
    const slug = 'REJ-1'
    const sessionId = 42
    const listFn = vi
      .fn()
      .mockResolvedValueOnce([
        row({ id: 1, summary: 'Root cause X', reviewState: 'pending', mode: 'investigation' })
      ])
      .mockRejectedValueOnce(new Error('IPC down'))
    ;(window.argus.findings as unknown as { list: unknown }).list = listFn
    render(
      <FindingsPane slug={slug} sessionId={sessionId} activeMode="investigation" onCite={vi.fn()} />
    )
    await screen.findByText('Root cause X')
    expect(screen.queryByText('No findings yet.')).toBeNull()

    // simulate a finding-added event, which is what bumps `findingsBump` and triggers a refetch
    const bumpEvent: AgentEvent = {
      eventId: 'e1',
      caseId: 1,
      caseSlug: slug,
      sessionId,
      turnId: null,
      ts: '2026-07-30T00:00:00Z',
      type: 'case.finding.added',
      payload: { markdown: '## New finding' }
    }
    await act(async () => {
      agentStore.apply(bumpEvent)
    })
    await waitFor(() => expect(listFn).toHaveBeenCalledTimes(2))

    expect(screen.getByText('Root cause X')).toBeInTheDocument()
    expect(screen.queryByText('No findings yet.')).toBeNull()
  })

  // Regression coverage: ReposSection guards its skeleton with `workspaces.length === 0` so a
  // refetch never blanks a populated list back to placeholders. FindingsPane's load effect resets
  // `loaded` to false on every `bump` (fired for EVERY finding an agent emits during a run, not
  // just a case/session switch) — if that refetch is slow enough to cross usePendingDisplay's
  // 150ms delay, the skeleton branch used to win ahead of `shown.length > 0` and replace findings
  // the user is reading with grey blocks, even though nothing about them is actually unknown.
  it('does not blank already-shown findings behind a skeleton during a slow bump-triggered refetch', async () => {
    const slug = 'SLOW-1'
    const sessionId = 42
    let resolveSecond: (rows: FindingRow[]) => void = () => {}
    const listFn = vi
      .fn()
      .mockResolvedValueOnce([
        row({ id: 1, summary: 'Root cause X', reviewState: 'pending', mode: 'investigation' })
      ])
      .mockImplementationOnce(
        () =>
          new Promise<FindingRow[]>((res) => {
            resolveSecond = res
          })
      )
    ;(window.argus.findings as unknown as { list: unknown }).list = listFn
    render(
      <FindingsPane slug={slug} sessionId={sessionId} activeMode="investigation" onCite={vi.fn()} />
    )
    await screen.findByText('Root cause X')

    // simulate a finding-added event, which bumps `findingsBump` and triggers the slow refetch
    const bumpEvent: AgentEvent = {
      eventId: 'e1',
      caseId: 1,
      caseSlug: slug,
      sessionId,
      turnId: null,
      ts: '2026-07-30T00:00:00Z',
      type: 'case.finding.added',
      payload: { markdown: '## New finding' }
    }
    await act(async () => {
      agentStore.apply(bumpEvent)
    })
    await waitFor(() => expect(listFn).toHaveBeenCalledTimes(2))

    // cross usePendingDisplay's 150ms delay while the refetch is still pending — this is the
    // exact window in which the skeleton used to win
    await act(async () => {
      await new Promise((r) => setTimeout(r, 220))
    })

    expect(screen.getByText('Root cause X')).toBeInTheDocument()
    expect(screen.queryByTestId('skeleton-rows')).toBeNull()

    await act(async () => {
      resolveSecond([
        row({ id: 1, summary: 'Root cause X', reviewState: 'pending', mode: 'investigation' })
      ])
    })
  })

  it('does not claim there are no findings while the list is still loading', async () => {
    let release: (rows: FindingRow[]) => void = () => {}
    window.argus.findings.list = vi.fn(
      () =>
        new Promise<FindingRow[]>((res) => {
          release = res
        })
    )
    render(<FindingsPane slug="C-1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)

    expect(screen.queryByText('No findings yet.')).toBeNull()

    await act(async () => {
      release([])
    })
    expect(screen.getByText('No findings yet.')).toBeInTheDocument()
  })
})
