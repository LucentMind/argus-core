// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
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

  // Finding 5 (whole-branch review): the mandated first-run notice string is ~132 characters, and
  // at the old `max-w-80` (320px) single-line truncation, roughly the first 45 render before the
  // ellipsis — the reader never sees "You can turn this off in Settings -> Updates.", the ONE
  // actionable half of the sentence. jsdom computes no layout, so it cannot see the truncation
  // itself; what it CAN pin is that the full text is reachable through the native title tooltip
  // regardless of how much of it fits on screen, and that the truncation budget was actually
  // widened rather than left at the old cap.
  it('carries the full message as a title, so a truncated notice is still reachable', async () => {
    render(<HeaderNotice />)
    const long =
      "Argus now keeps itself up to date — it installed 3 HiveMind items from your team's repo. You can turn this off in Settings → Updates."
    notice(long)
    const btn = await screen.findByRole('button', { name: `Dismiss: ${long}` })
    expect(btn).toHaveAttribute('title', long)
  })

  it('widens the truncation cap past the old 320px, which cut off the notice before its actionable half', async () => {
    render(<HeaderNotice />)
    notice('short')
    const btn = await screen.findByRole('button', { name: 'Dismiss: short' })
    expect(btn.className).not.toContain('max-w-80')
  })
})
