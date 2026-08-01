// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach } from 'vitest'
import { ToastHost } from '../ToastHost'
import { toastStore, toast } from '../../lib/toastStore'

beforeEach(() => {
  toastStore.reset()
})

describe('ToastHost', () => {
  it('renders nothing when the queue is empty', () => {
    const { container } = render(<ToastHost />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a queued message and dismisses it on click', async () => {
    const user = userEvent.setup()
    render(<ToastHost />)
    toast('Exported NN-5187 — 4.2 MB')
    const btn = await screen.findByRole('button', {
      name: 'Dismiss: Exported NN-5187 — 4.2 MB'
    })
    await user.click(btn)
    expect(screen.queryByText('Exported NN-5187 — 4.2 MB')).toBeNull()
  })

  it('marks a danger toast with the danger class', async () => {
    render(<ToastHost />)
    toast('Jira sync failed', 'danger')
    const btn = await screen.findByRole('button', { name: 'Dismiss: Jira sync failed' })
    expect(btn.className).toContain('text-danger')
  })
})
