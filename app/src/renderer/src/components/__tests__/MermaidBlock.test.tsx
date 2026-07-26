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
})
