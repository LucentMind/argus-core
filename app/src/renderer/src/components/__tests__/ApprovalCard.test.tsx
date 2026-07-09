// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

  it('hides approve-for-session for HIGH risk and sends deny comments', () => {
    render(<ApprovalCard slug="NAV-1" request={{ ...request, risk: 'HIGH', grantKey: null }} />)
    expect(screen.queryByRole('button', { name: /approve for session/i })).toBeNull()
    fireEvent.change(screen.getByPlaceholderText(/reason/i), { target: { value: 'not now' } })
    fireEvent.click(screen.getByRole('button', { name: /^deny$/i }))
    expect(window.argus.agent.respond).toHaveBeenCalledWith('NAV-1', {
      requestId: 'r1',
      kind: 'deny',
      comment: 'not now'
    })
  })
})
