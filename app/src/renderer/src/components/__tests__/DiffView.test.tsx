// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { DiffView } from '../references/DiffView'

describe('DiffView', () => {
  it('renders deleted and added lines', () => {
    render(<DiffView oldText={'a\nb'} newText={'a\nx'} />)
    expect(screen.getByText(/b/)).toBeTruthy()
    expect(screen.getByText(/x/)).toBeTruthy()
  })
})
