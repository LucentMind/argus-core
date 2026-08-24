// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { UnshownHoldsLine } from '../UnshownHoldsLine'

describe('UnshownHoldsLine', () => {
  it('names the gap', () => {
    render(<UnshownHoldsLine count={2} />)
    expect(screen.getByText('2 held-back items are not shown here.')).toBeInTheDocument()
  })

  it('renders nothing when the badge and the rows agree', () => {
    const { container } = render(<UnshownHoldsLine count={0} />)
    expect(container).toBeEmptyDOMElement()
  })
})
