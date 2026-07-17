// @vitest-environment jsdom
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ChatPane } from '../ChatPane'
import { agentStore } from '../../lib/agentStore'
import { uiStore } from '../../lib/uiStore'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings } from '../../../../shared/settings'
import type { AgentEvent } from '../../../../shared/agent-events'

const base = {
  eventId: 'e',
  caseId: 1,
  caseSlug: 'NAV-1',
  sessionId: 1,
  turnId: 1,
  ts: '2026-07-09T00:00:00Z'
}
const ev = (type: string, payload: unknown): AgentEvent =>
  ({ ...base, type, payload }) as AgentEvent

beforeEach(() => {
  settingsStore.reset()
  window.argus = {
    agent: { send: vi.fn(), interrupt: vi.fn(), onEvent: vi.fn(() => () => undefined) },
    sessions: {
      list: vi.fn(async () => [
        { id: 1, title: '', turnCount: 0, updatedAt: '2026-07-09T00:00:00Z' }
      ]),
      create: vi.fn(async () => ({
        id: 2,
        title: '',
        turnCount: 0,
        updatedAt: '2026-07-09T00:00:00Z'
      })),
      rename: vi.fn(async () => undefined)
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
    }
  } as never
})

describe('ChatPane', () => {
  it('renders transcript with citation chip and tool card', () => {
    agentStore.apply(ev('turn.started', { userText: 'why crash?' }))
    agentStore.apply(ev('assistant.message', { text: 'Crash at [evidence/log.txt:3]' }))
    agentStore.apply(
      ev('tool.call.started', { toolCallId: 't1', name: 'mcp__argus__search_evidence' })
    )
    const onCite = vi.fn()
    render(<ChatPane slug="NAV-1" sessionId={1} onSwitchSession={vi.fn()} onCite={onCite} />)
    expect(screen.getByText('why crash?')).toBeTruthy()
    // collapsed citation chip — clicking it only toggles expansion (which would
    // fetch a snippet via window.argus.evidence, unstubbed here); the
    // open-in-viewer -> onCite wiring is covered by CitationCard.test.tsx.
    const chip = screen.getByRole('button', { name: /log\.txt:3/ })
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText(/search_evidence/)).toBeTruthy()
  })

  it('hides tool cards when tool-call visibility is off, but keeps pending approvals', () => {
    const slug = 'NAV-TOGGLE'
    const at = (type: string, payload: unknown): AgentEvent =>
      ({ ...base, caseSlug: slug, type, payload }) as AgentEvent
    agentStore.apply(
      at('tool.call.started', { toolCallId: 't9', name: 'mcp__argus__read_evidence' })
    )
    agentStore.apply(
      at('request.opened', {
        requestId: 'r9',
        tool: 'Bash',
        risk: 'MEDIUM',
        grantKey: null,
        argsPreview: 'git push'
      })
    )
    uiStore.setShowToolCalls(false)
    try {
      render(<ChatPane slug={slug} sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />)
      expect(screen.queryByText(/read_evidence/)).toBeNull()
      expect(screen.getByText('git push')).toBeTruthy()
    } finally {
      uiStore.setShowToolCalls(true)
    }
  })

  it('sends composer text', () => {
    render(<ChatPane slug="NAV-1" sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />)
    const box = screen.getByPlaceholderText(/message the analyst/i)
    fireEvent.change(box, { target: { value: 'run /analyze-applog' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(window.argus.agent.send).toHaveBeenCalledWith('NAV-1', 1, 'run /analyze-applog')
  })

  it('renders a data-turn-id anchor on user turns for jump-to-turn', () => {
    const slug = 'NAV-ANCHOR'
    const at = (type: string, payload: unknown, turnId: number): AgentEvent =>
      ({ ...base, caseSlug: slug, type, payload, turnId }) as AgentEvent
    agentStore.apply(at('turn.started', { userText: 'anchor me' }, 10))
    const { container } = render(
      <ChatPane slug={slug} sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />
    )
    expect(container.querySelector('[data-turn-id="10"]')).toBeTruthy()
  })

  // Regression: a chat-search hit on ASSISTANT text must land on the matched
  // assistant message, not on the turn's user message. In single-turn chats
  // (slash-command investigations) the turn's user message IS the first
  // message of the chat, so the old turn-anchored jump scrolled to the top
  // and flashed message #1 even for text at the very end of the transcript.
  it('jump to an assistant hit scrolls to and flashes the matched assistant message', () => {
    const slug = 'NAV-JUMP-A'
    const at = (type: string, payload: unknown, turnId: number): AgentEvent =>
      ({ ...base, caseSlug: slug, type, payload, turnId }) as AgentEvent
    agentStore.apply(at('turn.started', { userText: 'run the pipeline' }, 7))
    agentStore.apply(at('assistant.message', { text: 'step one: parsing the log' }, 7))
    agentStore.apply(at('assistant.message', { text: 'step two: correlating spans' }, 7))
    agentStore.apply(
      at('assistant.message', { text: 'summary: root cause was a stale tile cache' }, 7)
    )
    const scrolled: Element[] = []
    Element.prototype.scrollIntoView = function () {
      scrolled.push(this)
    }
    const onFocusConsumed = vi.fn()
    const { container } = render(
      <ChatPane
        slug={slug}
        sessionId={1}
        onSwitchSession={vi.fn()}
        onCite={vi.fn()}
        focusTarget={{
          turnId: 7,
          role: 'assistant',
          snippet: '…root cause was a «stale» tile cache'
        }}
        onFocusConsumed={onFocusConsumed}
      />
    )
    // the matched assistant message is item index 3 (user, a1, a2, a3)
    const target = container.querySelector('[data-item-index="3"]')!
    expect(scrolled[scrolled.length - 1]).toBe(target)
    expect(target.className).toContain('bg-signal/20')
    // and NOT the turn's user anchor
    expect(scrolled[scrolled.length - 1]).not.toBe(container.querySelector('[data-turn-id="7"]'))
    expect(onFocusConsumed).toHaveBeenCalled()
  })

  it('jump to a user hit still scrolls to and flashes the turn user message', () => {
    const slug = 'NAV-JUMP-U'
    const at = (type: string, payload: unknown, turnId: number): AgentEvent =>
      ({ ...base, caseSlug: slug, type, payload, turnId }) as AgentEvent
    agentStore.apply(at('turn.started', { userText: 'first question' }, 1))
    agentStore.apply(at('assistant.message', { text: 'first answer' }, 1))
    agentStore.apply(at('turn.started', { userText: 'braking pressure follow-up' }, 2))
    agentStore.apply(at('assistant.message', { text: 'second answer' }, 2))
    const scrolled: Element[] = []
    Element.prototype.scrollIntoView = function () {
      scrolled.push(this)
    }
    const { container } = render(
      <ChatPane
        slug={slug}
        sessionId={1}
        onSwitchSession={vi.fn()}
        onCite={vi.fn()}
        focusTarget={{ turnId: 2, role: 'user', snippet: '«braking» pressure follow-up' }}
        onFocusConsumed={vi.fn()}
      />
    )
    expect(scrolled[scrolled.length - 1]).toBe(container.querySelector('[data-turn-id="2"]'))
    expect(scrolled[scrolled.length - 1]?.className).toContain('bg-signal/20')
  })

  // the anchor may only appear after the target session's history hydrates —
  // the jump must then still resolve, scroll, and flash
  it('jump waits for hydration: scrolls once the matched message appears', () => {
    const slug = 'NAV-JUMP-H'
    const at = (type: string, payload: unknown, turnId: number): AgentEvent =>
      ({ ...base, caseSlug: slug, type, payload, turnId }) as AgentEvent
    const scrolled: Element[] = []
    Element.prototype.scrollIntoView = function () {
      scrolled.push(this)
    }
    const onFocusConsumed = vi.fn()
    const { container } = render(
      <ChatPane
        slug={slug}
        sessionId={1}
        onSwitchSession={vi.fn()}
        onCite={vi.fn()}
        focusTarget={{ turnId: 9, role: 'assistant', snippet: 'ends with «frobnitz»' }}
        onFocusConsumed={onFocusConsumed}
      />
    )
    expect(onFocusConsumed).not.toHaveBeenCalled()
    act(() => {
      agentStore.hydrate(slug, 1, [
        at('turn.started', { userText: 'investigate' }, 9),
        at('assistant.message', { text: 'working on it' }, 9),
        at('assistant.message', { text: 'ends with frobnitz' }, 9)
      ] as AgentEvent[])
    })
    const target = container.querySelector('[data-item-index="2"]')!
    expect(scrolled[scrolled.length - 1]).toBe(target)
    expect(onFocusConsumed).toHaveBeenCalled()
  })

  it('opens the find overlay on Ctrl+F, rings matches, and refocuses composer on close', () => {
    const slug = 'NAV-FIND'
    const at = (type: string, payload: unknown, turnId: number): AgentEvent =>
      ({ ...base, caseSlug: slug, type, payload, turnId }) as AgentEvent
    agentStore.apply(at('turn.started', { userText: 'braking failed' }, 1))
    agentStore.apply(at('assistant.message', { text: 'unrelated reply' }, 1))
    const { container } = render(
      <ChatPane slug={slug} sessionId={1} onSwitchSession={vi.fn()} onCite={vi.fn()} />
    )
    expect(screen.queryByLabelText('Find in chat')).toBeNull()

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = screen.getByLabelText('Find in chat')
    expect(input).toBeTruthy()

    fireEvent.change(input, { target: { value: 'braking' } })
    const matchEl = container.querySelector('[data-item-index="0"]')
    expect(matchEl?.className).toContain('ring-2')
    expect(matchEl?.className).toContain('ring-signal')

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByLabelText('Find in chat')).toBeNull()
    expect(container.querySelector('textarea')).toBe(document.activeElement)
  })
})
