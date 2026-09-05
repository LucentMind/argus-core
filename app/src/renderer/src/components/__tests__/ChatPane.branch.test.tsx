// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ChatPane } from '../ChatPane'
import { ConfirmHost } from '../ConfirmHost'
import { agentStore } from '../../lib/agentStore'
import { sessionsStore } from '../../lib/sessionsStore'
import { settingsStore } from '../../lib/settingsStore'
import { composerDraft } from '../../lib/composerDraft'
import { defaultSettings } from '../../../../shared/settings'
import type { SessionSummary } from '../../../../shared/types'
import type { RewindPreview } from '../../../../shared/branching'
import type { AgentEvent } from '../../../../shared/agent-events'

const baseSession: SessionSummary = {
  id: 1,
  title: '',
  turnCount: 0,
  updatedAt: '2026-07-09T00:00:00Z',
  driverKind: 'claude-agent-sdk',
  instanceId: null,
  model: null,
  mode: 'investigation',
  runOptions: [],
  permissionMode: null,
  historyOrphaned: false,
  rewound: [],
  forkedFrom: null
}

const base = {
  eventId: 'e',
  caseId: 1,
  sessionId: 1,
  ts: '2026-07-09T00:00:00Z'
}

function apply(slug: string, turnId: number, type: string, payload: unknown): void {
  agentStore.apply({ ...base, caseSlug: slug, turnId, type, payload } as AgentEvent)
}

beforeEach(() => {
  settingsStore.reset()
  window.argus = {
    agent: {
      send: vi.fn(),
      interrupt: vi.fn(),
      onEvent: vi.fn(() => () => undefined)
    },
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
      rename: vi.fn(async () => undefined),
      rewindPreview: vi.fn(),
      rewind: vi.fn(),
      fork: vi.fn(),
      onChanged: vi.fn(() => () => {})
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
    evidence: {
      list: vi.fn(async () => []),
      onChanged: vi.fn(() => () => {})
    },
    providers: {
      statuses: vi.fn(async () => []),
      onChanged: vi.fn(() => () => {})
    }
  } as never
})

afterEach(() => {
  sessionsStore.clearForTests()
})

describe('ChatPane branching UI', () => {
  it('collapses rewound turns under a divider and expands them muted with no actions', async () => {
    const slug = 'NAV-REWOUND'
    apply(slug, 1, 'turn.started', { userText: 'keep me' })
    apply(slug, 1, 'assistant.message', { text: 'kept' })
    apply(slug, 2, 'turn.started', { userText: 'gone one' })
    apply(slug, 2, 'assistant.message', { text: 'gone reply' })
    sessionsStore.upsert(slug, {
      ...baseSession,
      id: 1,
      rewound: [{ turnId: 2, toTurnId: 1, at: '2026-09-04T00:00:00Z' }],
      forkedFrom: null
    })
    render(<ChatPane slug={slug} sessionId={1} onCite={vi.fn()} />)
    expect(screen.getByText(/Rewound 1 turn/)).toBeTruthy()
    expect(screen.queryByText('gone one')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /show rewound/i }))
    const tail = screen.getByText('gone one').closest('[data-rewound]')
    expect(tail).toBeTruthy()
    // TurnActions mounts on the live turn's reply ("kept"), but never inside the rewound tail.
    expect(screen.getByRole('button', { name: 'turn actions' })).toBeTruthy()
    expect(within(tail as HTMLElement).queryByRole('button', { name: /turn actions/i })).toBeNull()
  })

  it('makes an expanded rewound turn keyboard-inert, not just visually muted', () => {
    const slug = 'NAV-REWOUND-INERT'
    apply(slug, 1, 'turn.started', { userText: 'keep me' })
    apply(slug, 1, 'assistant.message', { text: 'kept' })
    apply(slug, 2, 'turn.started', { userText: 'gone one' })
    apply(slug, 2, 'tool.call.started', { toolCallId: 'tc1', name: 'Read' })
    apply(slug, 2, 'assistant.message', { text: 'see [evidence/x.log:1]' })
    sessionsStore.upsert(slug, {
      ...baseSession,
      id: 1,
      rewound: [{ turnId: 2, toTurnId: 1, at: '2026-09-04T00:00:00Z' }],
      forkedFrom: null
    })
    render(<ChatPane slug={slug} sessionId={1} onCite={vi.fn()} />)
    const toggle = screen.getByRole('button', { name: /show rewound/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    const toolButton = screen.getByText('Read').closest('button')
    const citeButton = screen.getByText(/x\.log:1/).closest('button')
    expect(toolButton).toBeTruthy()
    expect(citeButton).toBeTruthy()
    const inertAncestor = toolButton?.closest('[inert]')
    expect(inertAncestor).toBeTruthy()
    expect(inertAncestor?.closest('[data-rewound]')).toBeTruthy()
    expect(inertAncestor?.contains(citeButton!)).toBe(true)
  })

  it('renders the fork divider after the inherited turns with a link to the parent', () => {
    const slug = 'NAV-FORK'
    apply(slug, 5, 'turn.started', { userText: 'inherited' })
    apply(slug, 5, 'assistant.message', { text: 'r' })
    apply(slug, 6, 'turn.started', { userText: 'mine' })
    sessionsStore.upsert(slug, {
      ...baseSession,
      id: 1,
      rewound: [],
      forkedFrom: { sessionId: 7, turnId: 3, inheritedTurns: 1 }
    })
    const onSwitch = vi.fn()
    render(<ChatPane slug={slug} sessionId={1} onCite={vi.fn()} onSwitchSession={onSwitch} />)
    const divider = screen.getByText(/Forked from chat 7/)
    expect(
      divider.compareDocumentPosition(screen.getByText('mine')) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /open parent chat/i }))
    expect(onSwitch).toHaveBeenCalledWith(7)
  })

  it('still renders the fork divider when it falls inside a later-rewound run', () => {
    const slug = 'NAV-FORK-REWOUND'
    apply(slug, 1, 'turn.started', { userText: 'inherited one' })
    apply(slug, 1, 'assistant.message', { text: 'r1' })
    apply(slug, 2, 'turn.started', { userText: 'inherited two' })
    apply(slug, 2, 'assistant.message', { text: 'r2' })
    apply(slug, 3, 'turn.started', { userText: 'mine' })
    apply(slug, 3, 'assistant.message', { text: 'r3' })
    sessionsStore.upsert(slug, {
      ...baseSession,
      id: 1,
      rewound: [{ turnId: 2, toTurnId: 1, at: '2026-09-04T00:00:00Z' }],
      forkedFrom: { sessionId: 9, turnId: 4, inheritedTurns: 2 }
    })
    render(<ChatPane slug={slug} sessionId={1} onCite={vi.fn()} />)
    expect(screen.queryByText(/Forked from chat 9/)).toBeNull() // inside the collapsed tail
    fireEvent.click(screen.getByRole('button', { name: /show rewound/i }))
    const divider = screen.getByText(/Forked from chat 9/)
    expect(divider.closest('[data-rewound]')).toBeTruthy()
    expect(
      divider.compareDocumentPosition(screen.getByText('r2')) & Node.DOCUMENT_POSITION_PRECEDING
    ).toBeTruthy()
  })

  it('rewinds to the first turn, confirms, and prefills the composer from the result', async () => {
    const slug = 'NAV-REWIND-FLOW'
    apply(slug, 1, 'turn.started', { userText: 'first' })
    apply(slug, 1, 'assistant.message', { text: 'reply1' })
    apply(slug, 1, 'turn.completed', {})
    apply(slug, 2, 'turn.started', { userText: 'second' })
    apply(slug, 2, 'assistant.message', { text: 'reply2' })
    apply(slug, 2, 'turn.completed', {})
    sessionsStore.upsert(slug, { ...baseSession, id: 1, rewound: [], forkedFrom: null })

    const preview: RewindPreview = {
      anchorTurnId: 1,
      branching: 'digest',
      tail: [{ turnId: 2, userText: 'second' }],
      findingsToRetract: [],
      findingsStaying: [],
      externalActions: [],
      files: { kind: 'counts', writes: [] }
    }
    ;(window.argus.sessions.rewindPreview as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      preview
    )
    ;(window.argus.sessions.rewind as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      composerText: 'redo me'
    })

    render(
      <>
        <ConfirmHost />
        <ChatPane slug={slug} sessionId={1} onCite={vi.fn()} />
      </>
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'turn actions' })[0])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rewind to here' }))

    const confirmBtn = await screen.findByRole('button', { name: 'Rewind' })
    fireEvent.click(confirmBtn)

    await waitFor(() => expect(window.argus.sessions.rewind).toHaveBeenCalledWith(slug, 1, 1))
    await waitFor(() => expect(composerDraft.get(slug, 1)).toBe('redo me'))
  })

  it('disables Rewind to here (not Fork) on the last live turn, and both while a turn runs', async () => {
    const slug = 'NAV-REWIND-DISABLED'
    apply(slug, 1, 'turn.started', { userText: 'first' })
    apply(slug, 1, 'assistant.message', { text: 'reply1' })
    apply(slug, 1, 'turn.completed', {})
    apply(slug, 2, 'turn.started', { userText: 'second' })
    apply(slug, 2, 'assistant.message', { text: 'reply2' })
    apply(slug, 2, 'turn.completed', {})
    sessionsStore.upsert(slug, { ...baseSession, id: 1, rewound: [], forkedFrom: null })

    render(<ChatPane slug={slug} sessionId={1} onCite={vi.fn()} />)

    const triggers = screen.getAllByRole('button', { name: 'turn actions' })
    expect(triggers).toHaveLength(2)
    fireEvent.click(triggers[1]) // turn 2's menu — the last live turn
    expect(screen.getByRole('menuitem', { name: 'Rewind to here' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Fork from here' })).toBeEnabled()
    fireEvent.click(triggers[1]) // close

    apply(slug, 3, 'turn.started', { userText: 'third, still running' })
    fireEvent.click(screen.getAllByRole('button', { name: 'turn actions' })[1]) // still turn 2's — turn 3 has no reply yet
    const rewind = screen.getByRole('menuitem', { name: 'Rewind to here' })
    const fork = screen.getByRole('menuitem', { name: 'Fork from here' })
    expect(rewind).toBeDisabled()
    expect(rewind).toHaveAttribute('title', 'A turn is running')
    expect(fork).toBeDisabled()
    expect(fork).toHaveAttribute('title', 'A turn is running')
  })
})
