// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ApprovalCard } from '../ApprovalCard'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings } from '../../../../shared/settings'

const request = {
  requestId: 'r1',
  tool: 'Bash',
  risk: 'MEDIUM',
  grantKey: 'ws:/repo',
  argsPreview: 'git fetch origin'
}

function settingsGet(settings = defaultSettings()): () => Promise<unknown> {
  return vi.fn(async () => ({
    settings,
    resolvedTools: [],
    dataRoot: { path: 'C:\\x', fromEnv: false },
    loadError: null
  }))
}

beforeEach(() => {
  settingsStore.reset()
  window.argus = {
    agent: { respond: vi.fn() },
    settings: {
      get: settingsGet(),
      patch: vi.fn(),
      onChanged: vi.fn(() => () => {})
    }
  } as never
})

describe('ApprovalCard', () => {
  it('shows case slug, risk and args; approve-for-session only with grantKey', () => {
    render(<ApprovalCard slug="NAV-1" sessionId={1} request={request} />)
    expect(screen.getByText('NAV-1')).toBeTruthy()
    expect(screen.getByText('git fetch origin')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /approve for session/i }))
    expect(window.argus.agent.respond).toHaveBeenCalledWith('NAV-1', 1, {
      requestId: 'r1',
      kind: 'allow-session',
      comment: undefined
    })
  })

  it('hides approve-for-session for HIGH risk and sends deny comments; HIGH stays read-only even with MCP input', () => {
    render(
      <ApprovalCard
        slug="NAV-1"
        sessionId={1}
        request={{
          ...request,
          tool: 'mcp__rovo__addCommentToJiraIssue',
          risk: 'HIGH',
          grantKey: null,
          input: { body: 'x' }
        }}
      />
    )
    expect(screen.queryByRole('button', { name: /approve for session/i })).toBeNull()
    expect(screen.queryByLabelText('body')).toBeNull() // no editable field for the input
    expect(screen.getByText('git fetch origin')).toBeInTheDocument() // read-only <pre>, no editors
    fireEvent.change(screen.getByPlaceholderText(/reason/i), { target: { value: 'not now' } })
    fireEvent.click(screen.getByRole('button', { name: /^deny$/i }))
    expect(window.argus.agent.respond).toHaveBeenCalledWith('NAV-1', 1, {
      requestId: 'r1',
      kind: 'deny',
      comment: 'not now'
    })
  })
})

const mcpRequest = {
  requestId: 'r1',
  tool: 'mcp__rovo__addCommentToJiraIssue',
  risk: 'MEDIUM',
  grantKey: 'medium:mcp__rovo__addCommentToJiraIssue',
  argsPreview: '{"issueKey":"NAV-7","body":"draft RCA"}',
  input: { issueKey: 'NAV-7', body: 'draft RCA' }
}

describe('ApprovalCard editable MCP preview', () => {
  // the edit affordance only appears once the settings payload settles (the
  // pre-load fallback is deliberately conservative: editableApprovals false),
  // so editor lookups must be findBy*, not getBy*
  it('renders string fields as editors and sends edits as updatedInput on approve', async () => {
    render(<ApprovalCard slug="NAV-7" sessionId={2} request={mcpRequest} />)
    const body = await screen.findByLabelText('body')
    fireEvent.change(body, { target: { value: 'edited RCA' } })
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))
    expect(window.argus.agent.respond).toHaveBeenCalledWith('NAV-7', 2, {
      requestId: 'r1',
      kind: 'allow',
      comment: undefined,
      updatedInput: { issueKey: 'NAV-7', body: 'edited RCA' }
    })
  })

  it('sends no updatedInput when nothing was edited', async () => {
    render(<ApprovalCard slug="NAV-7" sessionId={2} request={mcpRequest} />)
    await screen.findByLabelText('body') // settings settled, editors up
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))
    expect(window.argus.agent.respond).toHaveBeenCalledWith('NAV-7', 2, {
      requestId: 'r1',
      kind: 'allow',
      comment: undefined,
      updatedInput: undefined
    })
  })

  it('deny never sends updatedInput even after edits', async () => {
    render(<ApprovalCard slug="NAV-7" sessionId={2} request={mcpRequest} />)
    fireEvent.change(await screen.findByLabelText('body'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /deny/i }))
    expect(window.argus.agent.respond).toHaveBeenCalledWith(
      'NAV-7',
      2,
      expect.objectContaining({ kind: 'deny', updatedInput: undefined })
    )
  })

  it('non-MCP tools and requests without input keep the read-only preview', () => {
    render(
      <ApprovalCard
        slug="NAV-7"
        sessionId={2}
        request={{
          requestId: 'r2',
          tool: 'Bash',
          risk: 'HIGH',
          grantKey: null,
          argsPreview: 'git push'
        }}
      />
    )
    expect(screen.getByText('git push')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'command' })).toBeNull()
  })

  it('gates the editable preview on the active driver capabilities.editableApprovals (copilot: false)', async () => {
    const s = defaultSettings()
    s.agent.providerInstances['claude-default'].driver = 'github-copilot'
    window.argus.settings.get = settingsGet(s)
    render(<ApprovalCard slug="NAV-7" sessionId={2} request={mcpRequest} />)
    // wait until the payload has actually settled, so the assertion covers the
    // settled copilot state, not merely the (also read-only) pre-load fallback
    await waitFor(() => expect(settingsStore.get()).not.toBeNull())
    expect(screen.queryByLabelText('body')).toBeNull()
    expect(screen.getByText(mcpRequest.argsPreview)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))
    expect(window.argus.agent.respond).toHaveBeenCalledWith('NAV-7', 2, {
      requestId: 'r1',
      kind: 'allow',
      comment: undefined,
      updatedInput: undefined
    })
  })

  it('stays read-only when settings never load (IPC failure settles the payload at null)', async () => {
    // SettingsStore.start() swallows a failed settings.get() — the payload stays
    // null indefinitely, a SETTLED state, and the conservative fallback must not
    // offer an edit affordance the (unknown) active driver might silently drop.
    window.argus.settings.get = vi.fn(async () => {
      throw new Error('ipc down')
    }) as never
    render(<ApprovalCard slug="NAV-7" sessionId={2} request={mcpRequest} />)
    // let the rejected fetch flush; the payload must still be null afterwards
    await new Promise((r) => setTimeout(r, 0))
    expect(settingsStore.get()).toBeNull()
    expect(screen.queryByLabelText('body')).toBeNull()
    expect(screen.getByText(mcpRequest.argsPreview)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))
    expect(window.argus.agent.respond).toHaveBeenCalledWith('NAV-7', 2, {
      requestId: 'r1',
      kind: 'allow',
      comment: undefined,
      updatedInput: undefined
    })
  })

  it('write_memory (allowlisted native tool) renders editable field editors at MEDIUM', async () => {
    render(
      <ApprovalCard
        slug="NAV-7"
        sessionId={2}
        request={{
          requestId: 'r3',
          tool: 'mcp__argus__write_memory',
          risk: 'MEDIUM',
          grantKey: null,
          argsPreview: '{"topic":"t","content":"draft"}',
          input: { topic: 't', content: 'draft' }
        }}
      />
    )
    expect(await screen.findByLabelText('content')).toBeTruthy()
  })

  it('update_case_status (non-allowlisted native tool) stays read-only at MEDIUM', () => {
    render(
      <ApprovalCard
        slug="NAV-7"
        sessionId={2}
        request={{
          requestId: 'r4',
          tool: 'mcp__argus__update_case_status',
          risk: 'MEDIUM',
          grantKey: null,
          argsPreview: '{"status":"closed"}',
          input: { status: 'closed' }
        }}
      />
    )
    expect(screen.queryByLabelText('status')).toBeNull()
    expect(screen.getByText('{"status":"closed"}')).toBeInTheDocument()
  })
})
