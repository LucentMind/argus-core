// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { ReviewRunButton } from '../ReviewRunButton'
import { panelsStore } from '../../lib/panelsStore'

const composeRunPrompt = vi.fn()
const send = vi.fn()

beforeEach(() => {
  composeRunPrompt.mockReset().mockResolvedValue({ ok: true, prompt: 'COMPOSED' })
  send.mockReset().mockResolvedValue(undefined)
  // @ts-expect-error test double for the preload bridge
  window.argus = { review: { composeRunPrompt }, agent: { send } }
})

describe('ReviewRunButton', () => {
  it('runs with no pinned layers by default', async () => {
    render(<ReviewRunButton slug="c1" sessionId={3} onError={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /^run review$/i }))
    await waitFor(() => expect(composeRunPrompt).toHaveBeenCalledWith('c1', 3, []))
    expect(send).toHaveBeenCalledWith('c1', 3, 'COMPOSED', true)
  })

  it('sends only the pinned layers', async () => {
    render(<ReviewRunButton slug="c1" sessionId={3} onError={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /choose review layers/i }))
    await userEvent.click(screen.getByRole('checkbox', { name: /security/i }))
    await userEvent.click(screen.getByRole('button', { name: /^run review$/i }))
    await waitFor(() => expect(composeRunPrompt).toHaveBeenCalledWith('c1', 3, ['security']))
  })

  it('opens the layer dropdown right-aligned so it stays inside the clipped card', async () => {
    // This button renders as PanelTabStrip's `action`, which Tasks 4/5 pushed to the far
    // right of the bar via `ml-auto`. A `left-0` popover would open away from the card's
    // right edge and be clipped by CaseWorkspace's `overflow-hidden` card (Task 3).
    render(<ReviewRunButton slug="c1" sessionId={3} onError={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /choose review layers/i }))
    const panel = screen.getByRole('group', { name: /review layers/i })
    expect(panel.className).toContain('right-0')
    expect(panel.className).not.toContain('left-0')
  })

  it('opens the no-PR notice right-aligned so it stays inside the clipped card', async () => {
    composeRunPrompt.mockResolvedValue({ ok: false, reason: 'no-pr-bound' })
    render(<ReviewRunButton slug="c1" sessionId={3} onError={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /^run review$/i }))
    const notice = await screen.findByRole('status')
    expect(notice.className).toContain('right-0')
    expect(notice.className).not.toContain('left-0')
  })

  it('is disabled with no session', () => {
    render(<ReviewRunButton slug="c1" sessionId={null} onError={vi.fn()} />)
    expect(screen.getByRole('button', { name: /^run review$/i })).toBeDisabled()
  })

  it('reports a genuine compose failure and sends nothing', async () => {
    composeRunPrompt.mockRejectedValue(new Error('The review prompt pack is missing.'))
    const onError = vi.fn()
    render(<ReviewRunButton slug="c1" sessionId={3} onError={onError} />)
    await userEvent.click(screen.getByRole('button', { name: /^run review$/i }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('The review prompt pack is missing.'))
    expect(send).not.toHaveBeenCalled()
  })

  // The layer dropdown is DOM; a docked panel's native WebContentsView paints over DOM. Now that
  // this button sits in the panel tab strip's row, opening its dropdown must occlude the docked
  // view the same way PanelTabStrip's own "New panel" launcher already does (PanelTabStrip.test.tsx).
  describe('occludes docked panels while the layer dropdown is open', () => {
    beforeEach(() => {
      panelsStore.setLauncherOpen(false)
    })

    it('sets the launcher-open flag on open and clears it on toggle-close', async () => {
      render(<ReviewRunButton slug="c1" sessionId={3} onError={vi.fn()} />)
      expect(panelsStore.get().occluded).toBe(false)

      await userEvent.click(screen.getByRole('button', { name: /choose review layers/i }))
      expect(panelsStore.get().occluded).toBe(true)

      await userEvent.click(screen.getByRole('button', { name: /choose review layers/i }))
      expect(panelsStore.get().occluded).toBe(false)
    })

    it('clears the flag when a run starts with the dropdown open', async () => {
      render(<ReviewRunButton slug="c1" sessionId={3} onError={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: /choose review layers/i }))
      expect(panelsStore.get().occluded).toBe(true)

      await userEvent.click(screen.getByRole('button', { name: /^run review$/i }))
      expect(panelsStore.get().occluded).toBe(false)
    })

    it('clears the flag on unmount instead of leaving it stuck true', async () => {
      const { unmount } = render(<ReviewRunButton slug="c1" sessionId={3} onError={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: /choose review layers/i }))
      expect(panelsStore.get().occluded).toBe(true)

      // Mirrors what happens when CaseWorkspace stops passing this as PanelTabStrip's `action`
      // (e.g. leaving review mode) while the layer dropdown is still open.
      unmount()
      expect(panelsStore.get().occluded).toBe(false)
    })

    it('closes on an outside click and clears occlusion (regression: no click-away listener)', async () => {
      render(
        <div>
          <ReviewRunButton slug="c1" sessionId={3} onError={vi.fn()} />
          <button type="button">outside</button>
        </div>
      )
      await userEvent.click(screen.getByRole('button', { name: /choose review layers/i }))
      expect(screen.getByRole('group', { name: /review layers/i })).toBeInTheDocument()
      expect(panelsStore.get().occluded).toBe(true)

      await userEvent.click(screen.getByRole('button', { name: 'outside' }))

      expect(screen.queryByRole('group', { name: /review layers/i })).not.toBeInTheDocument()
      expect(panelsStore.get().occluded).toBe(false)
    })

    it('closes on Escape and clears occlusion (regression: no Escape listener)', async () => {
      render(<ReviewRunButton slug="c1" sessionId={3} onError={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: /choose review layers/i }))
      expect(panelsStore.get().occluded).toBe(true)

      await userEvent.keyboard('{Escape}')

      expect(screen.queryByRole('group', { name: /review layers/i })).not.toBeInTheDocument()
      expect(panelsStore.get().occluded).toBe(false)
    })
  })

  describe('when the case has no pull request bound', () => {
    beforeEach(() => {
      composeRunPrompt.mockResolvedValue({ ok: false, reason: 'no-pr-bound' })
    })

    // The defect this replaces: main threw, Electron re-wrapped, and the raw string
    // "Error invoking remote method 'review:compose-run-prompt': Error: No pull request is
    // bound to this case." was painted in red over the chat. Not having linked a PR yet is an
    // ordinary state, so it reads as a prompt with a next step and never reaches onError —
    // which in CaseWorkspace sets sessionsError and BLANKS the whole transcript.
    it('offers a next step instead of an error, and never blanks the chat', async () => {
      const onError = vi.fn()
      render(<ReviewRunButton slug="c1" sessionId={3} onError={onError} />)
      await userEvent.click(screen.getByRole('button', { name: /^run review$/i }))

      const notice = await screen.findByRole('status')
      expect(notice).toHaveTextContent(/no pull request/i)
      expect(notice).toHaveTextContent(/link pr/i)
      expect(onError).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
    })

    it('never shows the user IPC plumbing', async () => {
      render(<ReviewRunButton slug="c1" sessionId={3} onError={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: /^run review$/i }))
      await screen.findByRole('status')
      expect(document.body.textContent).not.toMatch(/invoking remote method/i)
      expect(document.body.textContent).not.toMatch(/compose-run-prompt/i)
    })

    it('leaves the button usable so linking a PR then re-running just works', async () => {
      render(<ReviewRunButton slug="c1" sessionId={3} onError={vi.fn()} />)
      const button = screen.getByRole('button', { name: /^run review$/i })
      await userEvent.click(button)
      await screen.findByRole('status')
      expect(button).toBeEnabled()

      // The user links a PR in the rail and clicks again: the notice must clear.
      composeRunPrompt.mockResolvedValue({ ok: true, prompt: 'COMPOSED' })
      await userEvent.click(button)
      await waitFor(() => expect(send).toHaveBeenCalledWith('c1', 3, 'COMPOSED', true))
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })

    // Rebase integration with the header consolidation (PR #48): this notice is DOM in the
    // panel tab strip's row, and a docked panel's native WebContentsView paints over DOM —
    // the exact reason the layer dropdown above occludes. Without this the notice is not
    // "quietly styled", it is invisible behind the panel.
    it('occludes a docked panel while it is showing', async () => {
      panelsStore.setLauncherOpen(false)
      render(<ReviewRunButton slug="c1" sessionId={3} onError={vi.fn()} />)
      expect(panelsStore.get().occluded).toBe(false)

      await userEvent.click(screen.getByRole('button', { name: /^run review$/i }))
      await screen.findByRole('status')
      expect(panelsStore.get().occluded).toBe(true)
    })

    // And because it occludes, it MUST be self-clearing: a notice that only goes away via its
    // own dismiss button would keep the docked panel blanked until the user found that button.
    it('closes on an outside click and stops occluding', async () => {
      panelsStore.setLauncherOpen(false)
      render(
        <div>
          <ReviewRunButton slug="c1" sessionId={3} onError={vi.fn()} />
          <button type="button">outside</button>
        </div>
      )
      await userEvent.click(screen.getByRole('button', { name: /^run review$/i }))
      await screen.findByRole('status')

      await userEvent.click(screen.getByRole('button', { name: 'outside' }))

      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      expect(panelsStore.get().occluded).toBe(false)
    })

    it('closes on Escape and stops occluding', async () => {
      panelsStore.setLauncherOpen(false)
      render(<ReviewRunButton slug="c1" sessionId={3} onError={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: /^run review$/i }))
      await screen.findByRole('status')

      await userEvent.keyboard('{Escape}')

      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      expect(panelsStore.get().occluded).toBe(false)
    })

    it('clears occlusion on unmount rather than leaving it stuck true', async () => {
      panelsStore.setLauncherOpen(false)
      const { unmount } = render(<ReviewRunButton slug="c1" sessionId={3} onError={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: /^run review$/i }))
      await screen.findByRole('status')
      expect(panelsStore.get().occluded).toBe(true)

      unmount()
      expect(panelsStore.get().occluded).toBe(false)
    })

    it('dismisses via its own button too', async () => {
      panelsStore.setLauncherOpen(false)
      render(<ReviewRunButton slug="c1" sessionId={3} onError={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: /^run review$/i }))
      await screen.findByRole('status')

      await userEvent.click(screen.getByRole('button', { name: /dismiss/i }))

      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      expect(panelsStore.get().occluded).toBe(false)
    })
  })
})
