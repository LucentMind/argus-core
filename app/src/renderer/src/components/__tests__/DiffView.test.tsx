// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { DiffView } from '../references/DiffView'

describe('DiffView', () => {
  it('renders a split view by default with removed and added lines', () => {
    render(<DiffView oldText={'a\nb'} newText={'a\nx'} />)
    expect(screen.getByRole('group', { name: 'diff view mode' })).toBeTruthy()
    expect(screen.getByText('b')).toBeTruthy()
    expect(screen.getByText('x')).toBeTruthy()
    // unchanged lines appear once per side in split view
    expect(screen.getAllByText('a')).toHaveLength(2)
  })

  it('toggles to the unified view', () => {
    render(<DiffView oldText={'a\nb'} newText={'a\nx'} />)
    fireEvent.click(screen.getByRole('button', { name: 'Unified' }))
    expect(screen.getAllByText('a')).toHaveLength(1)
    expect(document.body.textContent).toContain('- b')
    expect(document.body.textContent).toContain('+ x')
  })
})
