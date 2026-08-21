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

  // Finding 5 (whole-branch review) plus a live-verification follow-up (task 9): the mandated
  // first-run notice string is ~132 characters, and at the ORIGINAL `max-w-80` (320px) single-line
  // truncation, roughly the first 45 characters rendered before the ellipsis — the reader never
  // saw "You can turn this off in Settings -> Updates.", the ONE actionable half of the sentence.
  // A first fix widened the cap to `max-w-[32rem]` (512px) but KEPT `truncate` (single line); a
  // live CDP measurement (task-9-live-report.md) found that STILL truncated the same string at
  // ~512px of its ~714px rendered width, cutting it off right after "You" — the same class of bug,
  // just a longer string away. jsdom computes no layout, so it cannot see either truncation
  // directly; what it CAN pin is that the full text is reachable through the native title tooltip
  // regardless of how much fits on screen, AND — the actual fix — that the single-line truncating
  // classes are gone and the wrapping ones are present. Neither this test nor jsdom can confirm
  // the text is actually LEGIBLE on screen (no layout engine here) — that is the live CDP
  // measurement's job, not a unit test's; see task-9-live-report.md for the pixel evidence.
  it('carries the full message as a title, so a truncated notice is still reachable', async () => {
    render(<HeaderNotice />)
    const long =
      "Argus now keeps itself up to date — it installed 3 HiveMind items from your team's repo. You can turn this off in Settings → Updates."
    notice(long)
    const btn = await screen.findByRole('button', { name: `Dismiss: ${long}` })
    expect(btn).toHaveAttribute('title', long)
  })

  it('wraps across lines instead of truncating to one, so a long notice is not cut off', async () => {
    render(<HeaderNotice />)
    notice('short')
    const btn = await screen.findByRole('button', { name: 'Dismiss: short' })
    // `truncate` (Tailwind's `whitespace-nowrap overflow-hidden text-overflow-ellipsis` shorthand)
    // is what silently ate the actionable half of the sentence — a single-line cap, however wide,
    // reproduces the same bug for a long-enough string. Its absence is necessary but not
    // sufficient (a plain unclamped div would also lack it), so this also pins the two classes
    // that positively express "this wraps": `line-clamp-2` (the same idiom settingsLayout.tsx and
    // CaseCard.tsx already use) and `whitespace-normal`, which together are what let the text
    // actually break onto a second line rather than run off the first.
    expect(btn.className).not.toContain('truncate')
    expect(btn.className).toContain('line-clamp-2')
    expect(btn.className).toContain('whitespace-normal')
  })
})
