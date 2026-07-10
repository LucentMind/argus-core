// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ApprovalCard } from '../ApprovalCard'

const request = {
  requestId: 'r1',
  tool: 'Bash',
  risk: 'MEDIUM',
  grantKey: 'ws:/repo',
  argsPreview: 'git fetch origin'
}

beforeEach(() => {
  window.argus = { agent: { respond: vi.fn() } } as never
})

describe('ApprovalCard', () => {
  it('shows case slug, risk and args; approve-for-session only with grantKey', () => {
    render(<ApprovalCard slug="NAV-1" request={request} />)
    expect(screen.getByText('NAV-1')).toBeTruthy()
    expect(screen.getByText('git fetch origin')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /approve for session/i }))
    expect(window.argus.agent.respond).toHaveBeenCalledWith('NAV-1', {
      requestId: 'r1',
      kind: 'allow-session',
      comment: undefined
    })
  })

  it('hides approve-for-session for HIGH risk and sends deny comments; HIGH stays read-only even with MCP input', () => {
    render(
      <ApprovalCard
        slug="NAV-1"
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
    expect(window.argus.agent.respond).toHaveBeenCalledWith('NAV-1', {
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
  it('renders string fields as editors and sends edits as updatedInput on approve', () => {
    render(<ApprovalCard slug="NAV-7" request={mcpRequest} />)
    const body = screen.getByLabelText('body')
    fireEvent.change(body, { target: { value: 'edited RCA' } })
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))
    expect(window.argus.agent.respond).toHaveBeenCalledWith('NAV-7', {
      requestId: 'r1',
      kind: 'allow',
      comment: undefined,
      updatedInput: { issueKey: 'NAV-7', body: 'edited RCA' }
    })
  })

  it('sends no updatedInput when nothing was edited', () => {
    render(<ApprovalCard slug="NAV-7" request={mcpRequest} />)
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))
    expect(window.argus.agent.respond).toHaveBeenCalledWith('NAV-7', {
      requestId: 'r1',
      kind: 'allow',
      comment: undefined,
      updatedInput: undefined
    })
  })

  it('deny never sends updatedInput even after edits', () => {
    render(<ApprovalCard slug="NAV-7" request={mcpRequest} />)
    fireEvent.change(screen.getByLabelText('body'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /deny/i }))
    expect(window.argus.agent.respond).toHaveBeenCalledWith(
      'NAV-7',
      expect.objectContaining({ kind: 'deny', updatedInput: undefined })
    )
  })

  it('non-MCP tools and requests without input keep the read-only preview', () => {
    render(
      <ApprovalCard
        slug="NAV-7"
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

  it('write_memory (allowlisted native tool) renders editable field editors at MEDIUM', () => {
    render(
      <ApprovalCard
        slug="NAV-7"
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
    expect(screen.getByLabelText('content')).toBeTruthy()
  })

  it('update_case_status (non-allowlisted native tool) stays read-only at MEDIUM', () => {
    render(
      <ApprovalCard
        slug="NAV-7"
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
