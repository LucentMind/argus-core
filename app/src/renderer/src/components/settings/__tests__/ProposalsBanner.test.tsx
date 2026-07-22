// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { proposalsStore } from '../../../lib/proposalsStore'
import { ProposalsBanner } from '../ProposalsBanner'

function stubArgus(proposals: Array<{ type: string }>): void {
  ;(window as never as { argus: unknown }).argus = {
    proposals: {
      list: vi.fn(async () => ({ proposals })),
      onChanged: vi.fn(() => () => {})
    }
  }
}

describe('ProposalsBanner', () => {
  beforeEach(() => proposalsStore.reset())

  it('shows the count for its types and navigates on Review', async () => {
    stubArgus([{ type: 'skill-new' }, { type: 'skill-edit' }, { type: 'recipe' }])
    const onReview = vi.fn()
    render(
      <ProposalsBanner types={['skill-new', 'skill-edit']} noun="skills" onReview={onReview} />
    )
    expect(await screen.findByText('2 pending proposals touch skills.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review →' }))
    expect(onReview).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when no matching proposals are pending', async () => {
    stubArgus([{ type: 'recipe' }])
    const { container } = render(
      <ProposalsBanner types={['memory-append']} noun="memory" onReview={vi.fn()} />
    )
    // allow the store prime to settle, then assert absence
    await Promise.resolve()
    expect(container).toBeEmptyDOMElement()
  })
})
