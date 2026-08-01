// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { TitleBarStrip } from '../TitleBarStrip'
import { TITLEBAR_HEIGHTS } from '../../../../shared/titleBarHeights'

describe('TitleBarStrip', () => {
  it('renders at the shared main height and is a drag region inset past the system buttons', () => {
    const { container } = render(<TitleBarStrip kind="main" />)
    const strip = container.firstElementChild as HTMLElement
    expect(strip.style.height).toBe(`${TITLEBAR_HEIGHTS.main}px`)
    expect(strip.classList.contains('argus-drag')).toBe(true)
    expect(strip.classList.contains('argus-titlebar-inset')).toBe(true)
  })

  it('paints bg-deep so the strip matches the native overlay colour', () => {
    // titleBar.ts hands the OS overlay `--bg-1` (Tailwind bg-deep). If this class drifts, the
    // strip silently falls back to the root's bg-void and the overlay reads visibly lighter.
    const { container } = render(<TitleBarStrip kind="main" />)
    const strip = container.firstElementChild as HTMLElement
    expect(strip.classList.contains('bg-deep')).toBe(true)
  })

  it('renders at the shared editor height', () => {
    const { container } = render(<TitleBarStrip kind="editor" />)
    const strip = container.firstElementChild as HTMLElement
    expect(strip.style.height).toBe(`${TITLEBAR_HEIGHTS.editor}px`)
  })

  // Replaces the old `label` prop's test. The editor window now hangs its whole chrome — the tab
  // strip and the active pane's action buttons — inside the strip, so the strip has to be a
  // container rather than a text slot.
  it('renders its children', () => {
    render(
      <TitleBarStrip kind="editor">
        <button type="button">Save</button>
      </TitleBarStrip>
    )
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })

  it('renders nothing when given no children', () => {
    const { container } = render(<TitleBarStrip kind="main" />)
    expect(container.textContent).toBe('')
    expect((container.firstElementChild as HTMLElement).childElementCount).toBe(0)
  })
})
