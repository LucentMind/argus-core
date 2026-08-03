// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FindingsPane } from '../FindingsPane'
import type { FindingRow } from '../../../../shared/observability'

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
    role: null,
    ...over
  }
}

const reviewRow = (over: Partial<FindingRow> = {}): FindingRow =>
  row({
    id: 7,
    summary: 'Inverted guard',
    layer: 'correctness',
    severity: 'major',
    diffPath: 'widget/src/guard.ts',
    diffLine: 17,
    suggestedChange: 'Flip it.',
    mode: 'review',
    ...over
  })

const list = vi.fn()
const composeActionPrompt = vi.fn()
const send = vi.fn()
const postFindingComment = vi.fn()
const worktreeHead = vi.fn()

beforeEach(() => {
  list.mockReset()
  composeActionPrompt.mockReset()
  send.mockReset()
  postFindingComment.mockReset()
  worktreeHead.mockReset()
  worktreeHead.mockResolvedValue(null)
  window.argus = {
    findings: { list, review: vi.fn(), clear: vi.fn() },
    cases: { readFindings: vi.fn().mockResolvedValue('') },
    review: { composeActionPrompt, postFindingComment, worktreeHead },
    agent: { send }
  } as never // test double for the preload bridge
})

describe('FindingsPane write actions', () => {
  it('shows no write actions on an investigation finding', async () => {
    list.mockResolvedValue([row({ summary: 'Root cause' })])
    render(<FindingsPane slug="c1" sessionId={1} activeMode="investigation" onCite={vi.fn()} />)
    expect(await screen.findByText('Root cause')).toBeInTheDocument()
    expect(screen.queryByLabelText('Post as PR comment')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Apply change and push')).not.toBeInTheDocument()
  })

  it('composes the comment turn and sends it', async () => {
    list.mockResolvedValue([reviewRow()])
    composeActionPrompt.mockResolvedValue('COMPOSED COMMENT')
    send.mockResolvedValue(undefined)
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    await userEvent.click(await screen.findByLabelText('Post as PR comment'))
    await waitFor(() => expect(send).toHaveBeenCalledWith('c1', 3, 'COMPOSED COMMENT', true))
    expect(composeActionPrompt).toHaveBeenCalledWith('c1', 3, [7], 'comment')
  })

  it('posts through the mechanism when the finding carries comment_body', async () => {
    list.mockResolvedValue([reviewRow({ commentBody: 'Stored prose.' })])
    postFindingComment.mockResolvedValue({ ok: true })
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    await userEvent.click(await screen.findByLabelText('Post as PR comment'))
    await waitFor(() => expect(postFindingComment).toHaveBeenCalledWith('c1', 3, 7))
    expect(composeActionPrompt).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('falls back to the composed turn when comment_body is absent', async () => {
    list.mockResolvedValue([reviewRow({ commentBody: null })])
    composeActionPrompt.mockResolvedValue('COMPOSED COMMENT')
    send.mockResolvedValue(undefined)
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    await userEvent.click(await screen.findByLabelText('Post as PR comment'))
    await waitFor(() => expect(send).toHaveBeenCalledWith('c1', 3, 'COMPOSED COMMENT', true))
    expect(postFindingComment).not.toHaveBeenCalled()
  })

  it('surfaces a mechanism failure reason', async () => {
    list.mockResolvedValue([reviewRow({ commentBody: 'Stored prose.' })])
    postFindingComment.mockResolvedValue({
      ok: false,
      reason: 'No pull request is bound to this case.'
    })
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    await userEvent.click(await screen.findByLabelText('Post as PR comment'))
    expect(await screen.findByText('No pull request is bound to this case.')).toBeInTheDocument()
  })

  // 'no-body' is the mechanism discovering there is in fact no stored prose (e.g. the finding
  // was edited out from under us) — the plan's stated behavior is to fall through to the
  // composed-turn path silently, not to show the internal token as an error.
  it('falls through to the composed turn when the mechanism reports no-body', async () => {
    list.mockResolvedValue([reviewRow({ commentBody: 'Stored prose.' })])
    postFindingComment.mockResolvedValue({ ok: false, reason: 'no-body' })
    composeActionPrompt.mockResolvedValue('COMPOSED COMMENT')
    send.mockResolvedValue(undefined)
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    await userEvent.click(await screen.findByLabelText('Post as PR comment'))
    await waitFor(() => expect(send).toHaveBeenCalledWith('c1', 3, 'COMPOSED COMMENT', true))
    expect(composeActionPrompt).toHaveBeenCalledWith('c1', 3, [7], 'comment')
    expect(screen.queryByText('no-body')).not.toBeInTheDocument()
  })

  // 'session-dead' is an internal token, not a sentence — map it to something readable instead
  // of showing it raw.
  it('maps a session-dead mechanism failure to a readable sentence', async () => {
    list.mockResolvedValue([reviewRow({ commentBody: 'Stored prose.' })])
    postFindingComment.mockResolvedValue({ ok: false, reason: 'session-dead' })
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    await userEvent.click(await screen.findByLabelText('Post as PR comment'))
    expect(await screen.findByText('The session is no longer running.')).toBeInTheDocument()
    expect(screen.queryByText('session-dead')).not.toBeInTheDocument()
  })

  // 'denied' is the user's own click at the approval card, not an error — stays silent.
  it('stays silent when the mechanism reports denied', async () => {
    list.mockResolvedValue([reviewRow({ commentBody: 'Stored prose.' })])
    postFindingComment.mockResolvedValue({ ok: false, reason: 'denied' })
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    await userEvent.click(await screen.findByLabelText('Post as PR comment'))
    await waitFor(() => expect(postFindingComment).toHaveBeenCalled())
    expect(composeActionPrompt).not.toHaveBeenCalled()
    expect(screen.queryByText('denied')).not.toBeInTheDocument()
  })

  it('composes the apply turn and sends it', async () => {
    list.mockResolvedValue([reviewRow()])
    composeActionPrompt.mockResolvedValue('COMPOSED APPLY')
    send.mockResolvedValue(undefined)
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    await userEvent.click(await screen.findByLabelText('Apply change and push'))
    await waitFor(() => expect(send).toHaveBeenCalledWith('c1', 3, 'COMPOSED APPLY', true))
    expect(composeActionPrompt).toHaveBeenCalledWith('c1', 3, [7], 'apply')
  })

  it('disables both actions on a finding with no diff anchor', async () => {
    list.mockResolvedValue([reviewRow({ diffPath: null, diffLine: null })])
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    expect(await screen.findByLabelText('Post as PR comment')).toBeDisabled()
    expect(screen.getByLabelText('Apply change and push')).toBeDisabled()
  })

  it('enables the apply action on a finding with an anchor but no suggested change', async () => {
    list.mockResolvedValue([reviewRow({ suggestedChange: null })])
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    expect(await screen.findByLabelText('Apply change and push')).toBeEnabled()
  })

  it('surfaces a compose failure instead of sending', async () => {
    list.mockResolvedValue([reviewRow()])
    composeActionPrompt.mockRejectedValue(new Error('No pull request is bound to this case.'))
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    await userEvent.click(await screen.findByLabelText('Post as PR comment'))
    expect(await screen.findByText('No pull request is bound to this case.')).toBeInTheDocument()
    expect(send).not.toHaveBeenCalled()
  })

  it('links a posted comment and badges a pushed sha', async () => {
    list.mockResolvedValue([
      reviewRow({
        commentUrl: 'https://github.com/acme/widget/pull/42#discussion_r1',
        pushedSha: '0123456789abcdef0123456789abcdef01234567'
      })
    ])
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    const item = (await screen.findByText('Inverted guard')).closest('li') as HTMLElement
    expect(within(item).getByRole('link', { name: /commented/i })).toHaveAttribute(
      'href',
      'https://github.com/acme/widget/pull/42#discussion_r1'
    )
    expect(within(item).getByText('0123456')).toBeInTheDocument()
  })

  it('applies the selected findings as one composed turn', async () => {
    list.mockResolvedValue([reviewRow({ id: 7 }), reviewRow({ id: 9 })])
    composeActionPrompt.mockResolvedValue('BATCH APPLY')
    send.mockResolvedValue(undefined)
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    await userEvent.click(await screen.findByLabelText('Select finding 7 for batch apply'))
    await userEvent.click(await screen.findByLabelText('Select finding 9 for batch apply'))
    await userEvent.click(screen.getByRole('button', { name: 'Apply selected (2)' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith('c1', 3, 'BATCH APPLY', true))
    expect(composeActionPrompt).toHaveBeenCalledWith('c1', 3, [7, 9], 'apply')
  })

  it('offers no checkbox on a finding without a diff anchor', async () => {
    list.mockResolvedValue([reviewRow({ id: 7, diffPath: null, diffLine: null })])
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    await screen.findByText('Inverted guard')
    expect(screen.queryByLabelText('Select finding 7 for batch apply')).toBeNull()
  })

  it('marks a finding stale when its head_sha is behind the worktree', async () => {
    worktreeHead.mockResolvedValue('54af8776e37c29084ad9454ab4a71166a9606138')
    list.mockResolvedValue([
      reviewRow({ id: 7, headSha: 'b994f1a61e2ea27c9c0ae9ec8a94f8a3d4302427' })
    ])
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    const chip = await screen.findByText('code moved')
    expect(chip).toHaveAttribute(
      'title',
      expect.stringMatching(/recorded at b994f1a61e2e.*now 54af8776e37c/i)
    )
  })

  it('shows no stale chip when the shas match or head_sha is null', async () => {
    worktreeHead.mockResolvedValue('54af8776e37c29084ad9454ab4a71166a9606138')
    list.mockResolvedValue([
      reviewRow({ id: 7, headSha: '54af8776e37c29084ad9454ab4a71166a9606138' }),
      reviewRow({ id: 9, headSha: null })
    ])
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    // waits for both rows to render before asserting absence (brief's `/summary/i` never
    // matches this fixture's summary text — 'Inverted guard' — so it would hang; this waits on
    // the same rendered rows by their actual text instead)
    await screen.findAllByText('Inverted guard')
    expect(screen.queryByText('code moved')).toBeNull()
  })

  it('colors the staleness chip with a real token', async () => {
    worktreeHead.mockResolvedValue('54af8776e37c29084ad9454ab4a71166a9606138')
    list.mockResolvedValue([
      reviewRow({ id: 7, headSha: 'b994f1a61e2ea27c9c0ae9ec8a94f8a3d4302427' })
    ])
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    const chip = await screen.findByText('code moved')
    // `warn` is not a token in theme.css — it compiled to nothing and the chip had no color.
    expect(chip.className).not.toMatch(/warn/)
    expect(chip).toHaveClass('text-defect')
  })

  it('states the deny-and-redo consequence on the batch button', async () => {
    list.mockResolvedValue([reviewRow({ id: 7 })])
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    await userEvent.click(await screen.findByLabelText('Select finding 7 for batch apply'))
    expect(screen.getByRole('button', { name: 'Apply selected (1)' })).toHaveAttribute(
      'title',
      expect.stringContaining('deny')
    )
  })

  it('puts the selection footer after the list, not inside the filter row', async () => {
    list.mockResolvedValue([reviewRow({ id: 7 })])
    const { container } = render(
      <FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />
    )
    await userEvent.click(await screen.findByLabelText('Select finding 7 for batch apply'))
    const apply = screen.getByRole('button', { name: 'Apply selected (1)' })
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement
    expect(scroller).not.toBeNull()
    // It used to render inside the filter-chip row, which PRECEDES the scroller.
    expect(scroller.compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('clears the selection from the footer', async () => {
    list.mockResolvedValue([reviewRow({ id: 7 })])
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    await userEvent.click(await screen.findByLabelText('Select finding 7 for batch apply'))
    expect(screen.getByRole('button', { name: 'Apply selected (1)' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(screen.queryByRole('button', { name: /Apply selected/ })).toBeNull()
    expect(
      (screen.getByLabelText('Select finding 7 for batch apply') as HTMLInputElement).checked
    ).toBe(false)
  })

  it('keeps the meta row between the title and the expanded body', async () => {
    list.mockResolvedValue([reviewRow({ id: 7, body: 'why it matters' })])
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    const title = await screen.findByText('Inverted guard')
    await userEvent.click(title)
    const item = title.closest('li') as HTMLElement
    const body = await screen.findByText('why it matters')
    const severity = within(item).getByText('major')
    expect(item.contains(severity)).toBe(true)
    // title → meta → body. Expanded, the meta row used to sit under the whole prose block.
    expect(title.compareDocumentPosition(severity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(severity.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('parks the actions in the provenance slot, reachable without a pointer', async () => {
    list.mockResolvedValue([reviewRow({ id: 7 })])
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    const comment = await screen.findByLabelText('Post as PR comment')
    const item = comment.closest('li') as HTMLElement
    const slot = within(item).getByTestId('finding-trailing')
    // one cell holds both: the row costs max(provenance, actions), not their sum
    expect(slot).toContainElement(comment)
    expect(slot).toContainElement(within(item).getByLabelText('Apply change and push'))
    expect(slot.textContent).toMatch(/sess 1/)
    // The cluster must stay focusable — it is the only keyboard path to comment/apply, and
    // `hidden`/`display:none` would drop it from the tab order. jsdom applies no CSS, so this
    // pins the structural half only; Task 7 step 6 checks that focus actually reveals it.
    comment.focus()
    expect(document.activeElement).toBe(comment)
  })

  it('reveals the action cluster via React state on focus, not a CSS focus-within variant', async () => {
    // The previous mechanism used `group/act` + `group-focus-within/act:` Tailwind variants.
    // Measured in a real browser after a clean dev-server restart: focusing a button inside the
    // trailing cell left the cluster's computed opacity at 0 — the named-group focus-within
    // variant does not fire. Replaced with plain React state (onFocus/onBlur on the trailing
    // cell) and conditional utility classes, which jsdom's class-string assertions can pin even
    // though jsdom applies no CSS at all.
    list.mockResolvedValue([reviewRow({ id: 7 })])
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    const comment = await screen.findByLabelText('Post as PR comment')
    const item = comment.closest('li') as HTMLElement
    const slot = within(item).getByTestId('finding-trailing')
    const cluster = slot.querySelector(':scope > div') as HTMLElement
    expect(cluster).not.toBeNull()

    expect(cluster).toHaveClass('opacity-0')
    expect(cluster).toHaveClass('pointer-events-none')

    fireEvent.focus(comment)
    expect(cluster).toHaveClass('opacity-100')
    expect(cluster).toHaveClass('pointer-events-auto')
    expect(cluster).not.toHaveClass('opacity-0')

    fireEvent.blur(comment)
    expect(cluster).toHaveClass('opacity-0')
    expect(cluster).toHaveClass('pointer-events-none')

    expect(cluster).not.toHaveClass('hidden')
  })

  it('offers write actions in review mode and votes in investigation mode, never both', async () => {
    // Both rows come back from the one fetch — findings are case-scoped in the DB and only
    // filtered by mode client-side (the effect's deps are [slug, sessionId, bump], not
    // activeMode), so a mode-only rerender must not require a second .list() resolution.
    list.mockResolvedValue([
      reviewRow({ id: 7 }),
      row({ id: 8, summary: 'triage finding', mode: 'investigation' })
    ])
    const view = render(
      <FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />
    )
    await screen.findByLabelText('Post as PR comment')
    expect(screen.getByLabelText('Apply change and push')).toBeInTheDocument()
    // rating a finding is an investigation-mode concern; review mode acts on it instead
    expect(screen.queryByLabelText('Mark finding good')).toBeNull()
    expect(screen.queryByLabelText('Mark finding not useful')).toBeNull()

    view.rerender(
      <FindingsPane slug="c1" sessionId={3} activeMode="investigation" onCite={vi.fn()} />
    )
    await screen.findByText('triage finding')
    expect(screen.getByLabelText('Mark finding good')).toBeInTheDocument()
    expect(screen.queryByLabelText('Post as PR comment')).toBeNull()
  })
})
