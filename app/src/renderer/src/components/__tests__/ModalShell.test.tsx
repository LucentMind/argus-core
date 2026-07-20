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
})
