// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { ReviewRunButton } from '../ReviewRunButton'

const composeRunPrompt = vi.fn()
const send = vi.fn()

beforeEach(() => {
  composeRunPrompt.mockReset().mockResolvedValue('COMPOSED')
  send.mockReset().mockResolvedValue(undefined)
  // @ts-expect-error test double for the preload bridge
  window.argus = { review: { composeRunPrompt }, agent: { send } }
})

describe('ReviewRunButton', () => {
  it('runs with no pinned layers by default', async () => {
    render(<ReviewRunButton slug="c1" sessionId={3} onError={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /^run review$/i }))
    await waitFor(() => expect(composeRunPrompt).toHaveBeenCalledWith('c1', 3, []))
    expect(send).toHaveBeenCalledWith('c1', 3, 'COMPOSED')
  })

  it('sends only the pinned layers', async () => {
    render(<ReviewRunButton slug="c1" sessionId={3} onError={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /choose review layers/i }))
    await userEvent.click(screen.getByRole('checkbox', { name: /security/i }))
    await userEvent.click(screen.getByRole('button', { name: /^run review$/i }))
    await waitFor(() => expect(composeRunPrompt).toHaveBeenCalledWith('c1', 3, ['security']))
  })

  it('is disabled with no session', () => {
    render(<ReviewRunButton slug="c1" sessionId={null} onError={vi.fn()} />)
    expect(screen.getByRole('button', { name: /^run review$/i })).toBeDisabled()
  })

  it('reports a compose failure and sends nothing', async () => {
    composeRunPrompt.mockRejectedValue(new Error('No PR bound to this case.'))
    const onError = vi.fn()
    render(<ReviewRunButton slug="c1" sessionId={3} onError={onError} />)
    await userEvent.click(screen.getByRole('button', { name: /^run review$/i }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('No PR bound to this case.'))
    expect(send).not.toHaveBeenCalled()
  })
})
