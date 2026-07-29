// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
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

beforeEach(() => {
  list.mockReset()
  composeActionPrompt.mockReset()
  send.mockReset()
  postFindingComment.mockReset()
  window.argus = {
    findings: { list, review: vi.fn(), clear: vi.fn() },
    cases: { readFindings: vi.fn().mockResolvedValue('') },
    review: { composeActionPrompt, postFindingComment },
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
    await waitFor(() => expect(send).toHaveBeenCalledWith('c1', 3, 'COMPOSED COMMENT'))
    expect(composeActionPrompt).toHaveBeenCalledWith('c1', 3, 7, 'comment')
  })

  it('posts through the mechanism when the finding carries comment_body', async () => {
    list.mockResolvedValue([reviewRow({ commentBody: 'Stored prose.' })])
    postFindingComment.mockResolvedValue({ ok: true })
    render(<FindingsPane slug="c1" sessionId={3} onCite={vi.fn()} />)
    await userEvent.click(await screen.findByLabelText('Post as PR comment'))
    await waitFor(() => expect(postFindingComment).toHaveBeenCalledWith('c1', 3, 7))
    expect(composeActionPrompt).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('falls back to the composed turn when comment_body is absent', async () => {
    list.mockResolvedValue([reviewRow({ commentBody: null })])
    composeActionPrompt.mockResolvedValue('COMPOSED COMMENT')
    send.mockResolvedValue(undefined)
    render(<FindingsPane slug="c1" sessionId={3} onCite={vi.fn()} />)
    await userEvent.click(await screen.findByLabelText('Post as PR comment'))
    await waitFor(() => expect(send).toHaveBeenCalledWith('c1', 3, 'COMPOSED COMMENT'))
    expect(postFindingComment).not.toHaveBeenCalled()
  })

  it('surfaces a mechanism failure reason', async () => {
    list.mockResolvedValue([reviewRow({ commentBody: 'Stored prose.' })])
    postFindingComment.mockResolvedValue({
      ok: false,
      reason: 'No pull request is bound to this case.'
    })
    render(<FindingsPane slug="c1" sessionId={3} onCite={vi.fn()} />)
    await userEvent.click(await screen.findByLabelText('Post as PR comment'))
    expect(await screen.findByText('No pull request is bound to this case.')).toBeInTheDocument()
  })

  it('composes the apply turn and sends it', async () => {
    list.mockResolvedValue([reviewRow()])
    composeActionPrompt.mockResolvedValue('COMPOSED APPLY')
    send.mockResolvedValue(undefined)
    render(<FindingsPane slug="c1" sessionId={3} activeMode="review" onCite={vi.fn()} />)
    await userEvent.click(await screen.findByLabelText('Apply change and push'))
    await waitFor(() => expect(send).toHaveBeenCalledWith('c1', 3, 'COMPOSED APPLY'))
    expect(composeActionPrompt).toHaveBeenCalledWith('c1', 3, 7, 'apply')
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
})
