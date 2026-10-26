// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatPane } from '../ChatPane'
import { agentStore } from '../../lib/agentStore'
import { findingsStore } from '../../lib/findingsStore'
import { uiStore } from '../../lib/uiStore'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings } from '../../../../shared/settings'
import type { AgentEvent } from '../../../../shared/agent-events'
import type { FindingRow } from '../../../../shared/observability'

const base = { eventId: 'e', caseId: 1, caseSlug: 'NAV-1', turnId: 1, ts: '2026-07-09T00:00:00Z' }

// agentStore has no reset hook (ChatPane.test.tsx never resets it either), so each test gets its
// own session id and therefore its own transcript.
let sessionId = 100
const ev = (type: string, payload: unknown): AgentEvent =>
  ({ ...base, sessionId, type, payload }) as AgentEvent

const finding = (over: Partial<FindingRow>): FindingRow =>
  ({
    id: 7,
    caseId: 1,
    sessionId: 1,
    turnId: 1,
    summary: 'Tile region blocked server-side',
    reviewState: 'pending',
    reviewedAt: null,
    createdAt: 'x',
    layer: null,
    severity: null,
    diffPath: null,
    diffLine: null,
    suggestedChange: null,
    commentUrl: null,
    pushedSha: null,
    commentBody: null,
    headSha: null,
    reviewReason: null,
    reviewActor: null,
    rejectTag: null,
    rejectNote: null,
    mode: 'investigation',
    role: null,
    body: 'See [evidence/log.txt:7]',
    ...over
  }) as FindingRow

const list = vi.fn()
const review = vi.fn()

beforeEach(() => {
  sessionId += 1
  settingsStore.reset()
  findingsStore.clearForTests()
  list.mockReset()
  review.mockReset()
  uiStore.setShowToolCalls(true)
  window.argus = {
    agent: { send: vi.fn(), interrupt: vi.fn(), onEvent: vi.fn(() => () => undefined) },
    sessions: {
      list: vi.fn(async () => [
        { id: sessionId, title: '', turnCount: 0, updatedAt: '2026-07-09T00:00:00Z' }
      ]),
      create: vi.fn()
    },
    skills: { list: vi.fn(async () => ({ skills: [] })) },
    settings: {
      get: vi.fn(async () => ({
        settings: defaultSettings(),
        resolvedTools: [],
        dataRoot: { path: 'C:\\x', fromEnv: false },
        loadError: null
      })),
      patch: vi.fn(),
      onChanged: vi.fn(() => () => {})
    },
    evidence: { list: vi.fn(async () => []), onChanged: vi.fn(() => () => {}) },
    providers: { statuses: vi.fn(async () => []), onChanged: vi.fn(() => () => {}) },
    findings: { list, review, delete: vi.fn() },
    review: { worktreeHead: vi.fn().mockResolvedValue(null) },
    workspaces: { list: vi.fn(async () => []), refs: vi.fn(async () => []) }
  } as never
})

function mountWithFinding(output = 'finding appended as #7', row = finding({})): void {
  list.mockResolvedValue([row])
  act(() => {
    agentStore.apply(ev('turn.started', { userText: 'go' }))
    agentStore.apply(
      ev('tool.call.started', { toolCallId: 't1', name: 'mcp__argus__append_finding' })
    )
    agentStore.apply(
      ev('tool.call.completed', {
        toolCallId: 't1',
        name: 'mcp__argus__append_finding',
        outputPreview: output,
        isError: false
      })
    )
  })
  render(<ChatPane slug="NAV-1" sessionId={sessionId} onCite={vi.fn()} />)
}

describe('ChatPane inline finding', () => {
  it('renders the recorded finding as a card with thumbs where the tool call was', async () => {
    mountWithFinding()
    await act(() => findingsStore.load('NAV-1'))
    expect(await screen.findByText('Tile region blocked server-side')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /mark finding good/i })).toBeInTheDocument()
    expect(screen.queryByText('argus:append_finding')).not.toBeInTheDocument()
  })
  it('a thumbs-up reviews through the store, so the rail would see it too', async () => {
    mountWithFinding()
    await act(() => findingsStore.load('NAV-1'))
    review.mockResolvedValue({ id: 7, reviewState: 'accepted', reviewActor: 'human' })
    await userEvent.click(await screen.findByRole('button', { name: /mark finding good/i }))
    expect(review).toHaveBeenCalledWith(7, 'accepted', undefined)
    expect(findingsStore.get('NAV-1').rows[0].reviewState).toBe('accepted')
  })
  it('a thumbs-down opens the reason strip under the inline card', async () => {
    mountWithFinding()
    await act(() => findingsStore.load('NAV-1'))
    review.mockResolvedValue({ id: 7, reviewState: 'rejected', reviewActor: 'human' })
    await userEvent.click(await screen.findByRole('button', { name: /mark finding not useful/i }))
    expect(await screen.findByRole('button', { name: 'Reject as wrong' })).toBeInTheDocument()
  })
  it('stays visible when tool cards are hidden — a finding is content, not plumbing', async () => {
    uiStore.setShowToolCalls(false)
    mountWithFinding()
    await act(() => findingsStore.load('NAV-1'))
    expect(await screen.findByText('Tile region blocked server-side')).toBeInTheDocument()
  })
  it('falls back to the plain tool card when the id cannot be resolved', async () => {
    mountWithFinding('finding appended')
    await act(() => findingsStore.load('NAV-1'))
    expect(screen.getByText('argus:append_finding')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /mark finding good/i })).not.toBeInTheDocument()
  })
  it('a review-mode finding keeps the plain tool card (Post/Apply live in the rail)', async () => {
    mountWithFinding('finding appended as #7', finding({ mode: 'review' }))
    await act(() => findingsStore.load('NAV-1'))
    expect(screen.getByText('argus:append_finding')).toBeInTheDocument()
  })
})
