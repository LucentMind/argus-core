// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ChatPane } from '../ChatPane'
import { agentStore } from '../../lib/agentStore'
import type { AgentEvent } from '../../../../shared/agent-events'

const base = {
  eventId: 'e', caseId: 1, caseSlug: 'NAV-1', sessionId: 1, turnId: 1, ts: '2026-07-09T00:00:00Z'
}
const ev = (type: string, payload: unknown): AgentEvent => ({ ...base, type, payload }) as AgentEvent

beforeEach(() => {
  window.argus = {
    agent: { send: vi.fn(), onEvent: vi.fn(() => () => undefined) },
    skills: { list: vi.fn(async () => []) }
  } as never
})

describe('ChatPane', () => {
  it('renders transcript with citation link and tool card', () => {
    agentStore.apply(ev('turn.started', { userText: 'why crash?' }))
    agentStore.apply(ev('assistant.message', { text: 'Crash at [evidence/log.txt:3]' }))
    agentStore.apply(ev('tool.call.started', { toolCallId: 't1', name: 'mcp__argus__search_evidence' }))
    const onCite = vi.fn()
    render(<ChatPane slug="NAV-1" onCite={onCite} />)
    expect(screen.getByText('why crash?')).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: 'evidence/log.txt:3' }))
    expect(onCite).toHaveBeenCalledWith('evidence/log.txt', 3)
    expect(screen.getByText(/search_evidence/)).toBeTruthy()
  })

  it('sends composer text', () => {
    render(<ChatPane slug="NAV-1" onCite={vi.fn()} />)
    const box = screen.getByPlaceholderText(/message the analyst/i)
    fireEvent.change(box, { target: { value: 'run /analyze-applog' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(window.argus.agent.send).toHaveBeenCalledWith('NAV-1', 'run /analyze-applog')
  })
})
