// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { EditorPane } from '../EditorPane'

const parts = {
  surface: <div data-testid="surface">surface</div>,
  preview: <div data-testid="preview">preview</div>
}

describe('EditorPane', () => {
  it('shows only the editor in editor mode', () => {
    render(
      <EditorPane viewMode="editor" splitFraction={0.5} onSplitFraction={vi.fn()} {...parts} />
    )
    expect(screen.getByTestId('surface')).toBeInTheDocument()
    expect(screen.queryByTestId('preview')).not.toBeInTheDocument()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })

  it('shows both panes and a splitter in split mode', () => {
    render(<EditorPane viewMode="split" splitFraction={0.5} onSplitFraction={vi.fn()} {...parts} />)
    expect(screen.getByTestId('surface')).toBeInTheDocument()
    expect(screen.getByTestId('preview')).toBeInTheDocument()
    expect(screen.getByRole('separator', { name: 'Resize preview' })).toBeInTheDocument()
  })

  it('keeps the surface mounted but inert in preview mode', () => {
    render(
      <EditorPane viewMode="preview" splitFraction={0.5} onSplitFraction={vi.fn()} {...parts} />
    )
    // Mounted: unmounting CodeMirror would discard undo history and cursor on every flip to
    // Preview and back.
    const surface = screen.getByTestId('surface')
    expect(surface).toBeInTheDocument()
    expect(surface.parentElement).toHaveAttribute('inert')
  })

  it('moves the split with the arrow keys, clamped', async () => {
    const onSplitFraction = vi.fn()
    render(
      <EditorPane
        viewMode="split"
        splitFraction={0.8}
        onSplitFraction={onSplitFraction}
        {...parts}
      />
    )
    const splitter = screen.getByRole('separator', { name: 'Resize preview' })
    splitter.focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(onSplitFraction).toHaveBeenLastCalledWith(0.75)
    await userEvent.keyboard('{ArrowRight}')
    expect(onSplitFraction).toHaveBeenLastCalledWith(0.8)
  })

  it('reports its position and range to assistive tech', () => {
    render(
      <EditorPane viewMode="split" splitFraction={0.35} onSplitFraction={vi.fn()} {...parts} />
    )
    const splitter = screen.getByRole('separator', { name: 'Resize preview' })
    expect(splitter).toHaveAttribute('aria-valuenow', '35')
    expect(splitter).toHaveAttribute('aria-valuemin', '20')
    expect(splitter).toHaveAttribute('aria-valuemax', '80')
  })
})
