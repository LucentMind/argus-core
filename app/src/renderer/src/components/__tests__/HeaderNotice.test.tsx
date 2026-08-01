// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach } from 'vitest'
import { HeaderNotice } from '../HeaderNotice'
import { noticeStore, notice } from '../../lib/noticeStore'

beforeEach(() => {
  noticeStore.reset()
})

describe('HeaderNotice', () => {
  it('renders nothing when the queue is empty', () => {
    const { container } = render(<HeaderNotice />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a queued message inline, with no fixed positioning, and dismisses it on click', async () => {
    const user = userEvent.setup()
    render(<HeaderNotice />)
    notice('Exported NN-5187 — 4.2 MB')
    const btn = await screen.findByRole('button', {
      name: 'Dismiss: Exported NN-5187 — 4.2 MB'
    })
    expect(btn.className).not.toContain('fixed')
    expect(btn.className).not.toContain('z-50')
    await user.click(btn)
    expect(screen.queryByText('Exported NN-5187 — 4.2 MB')).toBeNull()
  })

  it('marks a danger notice with the danger class and a default one with the dim class', async () => {
    render(<HeaderNotice />)
    notice('Jira sync failed', 'danger')
    const btn = await screen.findByRole('button', { name: 'Dismiss: Jira sync failed' })
    expect(btn.className).toContain('text-danger')

    notice('exported 3 files')
    const info = await screen.findByRole('button', { name: 'Dismiss: exported 3 files' })
    expect(info.className).toContain('text-dim')
  })

  it('renders only the newest notice, not a stack', async () => {
    render(<HeaderNotice />)
    notice('first')
    notice('second')
    expect(await screen.findByText('second')).toBeTruthy()
    expect(screen.queryByText('first')).toBeNull()
  })
})
