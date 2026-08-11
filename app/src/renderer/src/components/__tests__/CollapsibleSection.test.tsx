// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { CollapsibleSection } from '../CollapsibleSection'
import { uiStore } from '../../lib/uiStore'

beforeEach(() => {
  localStorage.clear()
  uiStore.setRailSectionCollapsed('repos', false)
})

function renderSection(): void {
  render(
    <CollapsibleSection
      id="repos"
      name="Repos"
      className="flex flex-col gap-1"
      header={<h2>Repos</h2>}
    >
      <div>body row one</div>
      <div>body row two</div>
    </CollapsibleSection>
  )
}

describe('CollapsibleSection', () => {
  it('shows the body and an expanded toggle when not collapsed', () => {
    renderSection()

    expect(screen.getByText('body row one')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse Repos' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })

  it('hides the body but keeps the header when collapsed', () => {
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Repos' }))

    expect(screen.queryByText('body row one')).not.toBeInTheDocument()
    expect(screen.queryByText('body row two')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Repos' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand Repos' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  it('restores the body on a second click', () => {
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Repos' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand Repos' }))

    expect(screen.getByText('body row one')).toBeInTheDocument()
  })

  it('writes the collapse through to the store, so a remount keeps it', () => {
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Repos' }))

    expect(uiStore.get().railCollapsed.repos).toBe(true)
  })

  it('renders the body as direct children of the container, not inside a wrapper', () => {
    const { container } = render(
      <CollapsibleSection id="pr" name="Pull request" className="wrapper" header={<span>PR</span>}>
        <div data-testid="row">body</div>
      </CollapsibleSection>
    )

    // Each section's container is `flex flex-col gap-*`, and that gap applies between DIRECT
    // children. A body wrapper would collapse every internal row gap into one.
    expect(screen.getByTestId('row').parentElement).toBe(container.firstChild)
  })

  it('passes the container classes through verbatim', () => {
    const { container } = render(
      <CollapsibleSection
        id="jira"
        name="Ticket"
        className="flex flex-col gap-1 px-2.5"
        header={<span>T</span>}
      >
        <div>body</div>
      </CollapsibleSection>
    )

    expect(container.firstChild).toHaveClass('flex', 'flex-col', 'gap-1', 'px-2.5')
  })

  // PrCompanionSection drives its P1 tier styling off this attribute on the container
  // (PrCompanionSection.tsx:406). Moving the container into this component must not drop it.
  it('forwards dataTier to the container', () => {
    const { container } = render(
      <CollapsibleSection id="pr" name="Pull request" dataTier="p1" header={<span>PR</span>}>
        <div>body</div>
      </CollapsibleSection>
    )

    expect(container.firstChild).toHaveAttribute('data-tier', 'p1')
  })
})
