// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ChatPane } from '../ChatPane'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings } from '../../../../shared/settings'
import type { SessionSummary } from '../../../../shared/types'

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
  historyOrphaned: false
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

function renderChatPane(
  overrides: { session?: SessionSummary | null } = {}
): ReturnType<typeof render> {
  return render(
    <ChatPane slug="NAV-1" sessionId={1} onCite={vi.fn()} session={overrides.session ?? null} />
  )
}

describe('ChatPane history-orphaned banner', () => {
  it('warns when the chat shows history the agent does not have', () => {
    renderChatPane({ session: { ...baseSession, historyOrphaned: true } })
    expect(screen.getByText(/does not have it as context/i)).toBeInTheDocument()
  })

  it('says nothing for a healthy chat', () => {
    renderChatPane({ session: { ...baseSession, historyOrphaned: false } })
    expect(screen.queryByText(/does not have it as context/i)).not.toBeInTheDocument()
  })

  // `historyOrphaned` is computed in main at list time and nothing else refetched the list
  // after a turn, so the banner kept promising "your next message will carry a summary of it"
  // long after the turn that consumed the digest made that false.
  it('refetches the session list so the flag can go stale-free after a turn', async () => {
    renderChatPane({ session: { ...baseSession, historyOrphaned: true } })
    await waitFor(() => expect(window.argus.sessions.list).toHaveBeenCalledWith('NAV-1'))
  })

  it('does not refetch for a healthy chat', async () => {
    renderChatPane({ session: { ...baseSession, historyOrphaned: false } })
    await Promise.resolve()
    expect(window.argus.sessions.list).not.toHaveBeenCalled()
  })

  it('can be dismissed', async () => {
    const user = userEvent.setup()
    renderChatPane({ session: { ...baseSession, historyOrphaned: true } })
    await user.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(screen.queryByText(/does not have it as context/i)).not.toBeInTheDocument()
  })
})
