// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// vi.hoisted: the vi.mock factory is hoisted above const declarations
const { renderMermaidMock } = vi.hoisted(() => ({
  renderMermaidMock: vi.fn<(src: string) => Promise<{ ok: true; svg: string }>>(async () => ({
    ok: true,
    svg: '<svg data-testid="mmd-svg"></svg>'
  }))
}))
vi.mock('../../lib/mermaid', () => ({ renderMermaid: (src: string) => renderMermaidMock(src) }))

import { MermaidBlock } from '../MermaidBlock'

beforeEach(() => renderMermaidMock.mockClear())

const SRC = 'flowchart TD\n A-->B'

describe('MermaidBlock', () => {
  it('renders the svg once finalized', async () => {
    render(<MermaidBlock source={SRC} />)
    const fig = await screen.findByRole('button', { name: 'Expand diagram' }, { timeout: 2000 })
    expect(fig.innerHTML).toContain('<svg')
    expect(renderMermaidMock).toHaveBeenCalledWith(SRC)
  })

  it('streaming: shows the plain code block and never calls the renderer', async () => {
    render(<MermaidBlock source={SRC} streaming />)
    expect(screen.getByText(/flowchart TD/)).toBeTruthy()
    await new Promise((r) => setTimeout(r, 300))
    expect(renderMermaidMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Expand diagram' })).toBeNull()
  })

  it('falls back to the code block with a note when rendering fails', async () => {
    renderMermaidMock.mockResolvedValueOnce({ ok: false } as never)
    render(<MermaidBlock source="broken" />)
    expect(
      await screen.findByText(/diagram failed to render/i, undefined, { timeout: 2000 })
    ).toBeTruthy()
    expect(screen.getByText('broken')).toBeTruthy()
  })

  it('click expands into a lightbox; Escape closes it', async () => {
    render(<MermaidBlock source={SRC} />)
    const fig = await screen.findByRole('button', { name: 'Expand diagram' }, { timeout: 2000 })
    fireEvent.click(fig)
    expect(screen.getByRole('dialog', { name: 'Diagram' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Diagram' })).toBeNull()
  })

  it('the lightbox opts out of the window drag region', async () => {
    // Worst case of the ModalShell drag-region bug: this card is `h-full` inside a `p-8`
    // backdrop, so its top edge is at 32px — flush under TitleBarStrip and squarely inside
    // TopBar's drag rect (32–80) at every window size. Chromium subtracts a no-drag rect from
    // the drag rect beneath it; painting on top does nothing. Without this the top 48px of a
    // scrollable full-size diagram dragged the window instead of panning. jsdom implements no
    // app-region, so this is the class contract only.
    render(<MermaidBlock source={SRC} />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Expand diagram' }, { timeout: 2000 })
    )
    expect(screen.getByRole('dialog', { name: 'Diagram' }).className).toContain('argus-nodrag')
  })
})
