// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { TierBadge } from '../TierBadge'

describe('TierBadge', () => {
  it('renders the tier label with its explanation as tooltip', () => {
    render(<TierBadge tier="team-knowledge" />)
    const chip = screen.getByText('proposed')
    expect(chip).toBeInTheDocument()
    expect(chip.closest('[title]')).toHaveAttribute(
      'title',
      'An agent drafted this; you accepted it. Yours to edit, delete, or share.'
    )
  })

  it('renders nothing for an unknown tier string', () => {
    const { container } = render(<TierBadge tier="banana" />)
    expect(container).toBeEmptyDOMElement()
  })
})
