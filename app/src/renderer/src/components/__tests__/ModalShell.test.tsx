// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModalShell } from '../ModalShell'
import { __resetEscapeLayersForTest } from '../../lib/escapeLayer'

afterEach(() => __resetEscapeLayersForTest())

describe('ModalShell', () => {
  it('closes on Escape', async () => {
    const onClose = vi.fn()
    render(
      <ModalShell title="T" onClose={onClose}>
        body
      </ModalShell>
    )
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on backdrop click but not on card click', async () => {
    const onClose = vi.fn()
    render(
      <ModalShell title="T" onClose={onClose}>
        <span>body</span>
      </ModalShell>
    )
    await userEvent.click(screen.getByText('body'))
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('modal-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes via the X button', async () => {
    const onClose = vi.fn()
    render(
      <ModalShell title="T" onClose={onClose}>
        body
      </ModalShell>
    )
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close on Escape while a field inside it is focused', async () => {
    const onClose = vi.fn()
    render(
      <ModalShell title="T" onClose={onClose}>
        <input aria-label="f" />
      </ModalShell>
    )
    await userEvent.click(screen.getByLabelText('f'))
    await userEvent.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a re-rendering background shell does not steal Escape from the top shell', async () => {
    const bottom = vi.fn()
    const top = vi.fn()
    function Harness(): React.JSX.Element {
      const [n, setN] = useState(0)
      return (
        <>
          {/* inline arrows deliberately: fresh identity on every render */}
          <ModalShell title={`bottom ${n}`} onClose={() => bottom()}>
            <button onClick={() => setN((x) => x + 1)}>bump</button>
          </ModalShell>
          <ModalShell title="top" onClose={() => top()}>
            top body
          </ModalShell>
        </>
      )
    }
    render(<Harness />)
    await userEvent.click(screen.getByText('bump')) // re-renders the bottom shell
    await userEvent.keyboard('{Escape}')
    expect(top).toHaveBeenCalledTimes(1)
    expect(bottom).not.toHaveBeenCalled()
  })

  it('forwards keydown to the onKeyDown passthrough', async () => {
    const onKeyDown = vi.fn()
    render(
      <ModalShell title="T" onClose={vi.fn()} onKeyDown={onKeyDown}>
        <span>body</span>
      </ModalShell>
    )
    await userEvent.click(screen.getByText('body'))
    await userEvent.keyboard('{Control>}f{/Control}')
    expect(onKeyDown).toHaveBeenCalled()
  })

  it('the backdrop is theme-aware, not a hardcoded black', () => {
    const { getByTestId } = render(
      <ModalShell title="t" onClose={() => undefined}>
        body
      </ModalShell>
    )
    const cls = getByTestId('modal-backdrop').className
    // bg-black/60 is a dark-theme assumption; on a pale ground it reads as a blackout.
    expect(cls).not.toContain('bg-black')
    expect(cls).toContain('modal-scrim')
  })

  it('the dialog card carries both the flat classes and the frosted material', () => {
    // Review on Task 8 came back dark-flat, light-frosted: `glass-card` supplies the frosted
    // look, but theme-dynamic.css gates it to light for `role="dialog"` (see the "overlay
    // opt-out" tests in themeTokens.test.ts), so the flat utility classes must stay on the
    // element too — they're what actually renders in dark, and what its `revert-layer` falls
    // back to. jsdom resolves no cascade, so this only proves the class *contract*: it cannot
    // tell you which theme wins. The real-browser, computed-style proof of dark-vs-light lives
    // in the Task 8 follow-up report, not in anything jsdom can run.
    const { getByRole } = render(
      <ModalShell title="t" onClose={() => undefined}>
        body
      </ModalShell>
    )
    const cls = getByRole('dialog').className
    expect(cls).toContain('glass-card')
    expect(cls).toContain('border-hair2')
    expect(cls).toContain('bg-panel')
    expect(cls).toContain('shadow-2xl')
  })
})
