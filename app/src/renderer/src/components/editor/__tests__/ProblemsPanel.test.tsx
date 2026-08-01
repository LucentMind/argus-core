// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { ProblemsPanel } from '../ProblemsPanel'
import type { ValidationIssue } from '../../../../../shared/assetValidation'

const ISSUES: ValidationIssue[] = [
  { severity: 'error', message: 'Frontmatter is missing name.', line: 2 },
  { severity: 'warning', message: '"triage" is not a role I know.', line: 4 },
  { severity: 'error', message: 'The file has no body below the frontmatter.' }
]

describe('ProblemsPanel', () => {
  it('lists every issue', () => {
    render(<ProblemsPanel issues={ISSUES} onGoToLine={vi.fn()} />)
    expect(screen.getByText('Frontmatter is missing name.')).toBeInTheDocument()
    expect(screen.getByText('The file has no body below the frontmatter.')).toBeInTheDocument()
  })

  it('jumps to the line when a locatable row is clicked', async () => {
    const onGoToLine = vi.fn()
    render(<ProblemsPanel issues={ISSUES} onGoToLine={onGoToLine} />)
    await userEvent.click(screen.getByRole('button', { name: /Frontmatter is missing name/ }))
    expect(onGoToLine).toHaveBeenCalledWith(2)
  })

  it('renders an unlocatable issue as text, not as a dead button', async () => {
    const onGoToLine = vi.fn()
    render(<ProblemsPanel issues={ISSUES} onGoToLine={onGoToLine} />)
    // Spec §5.4: no line means no jump target. A button that does nothing when clicked is worse
    // than plain text — it promises a location the issue does not have.
    expect(
      screen.queryByRole('button', { name: /no body below the frontmatter/ })
    ).not.toBeInTheDocument()
    expect(screen.getByText('The file has no body below the frontmatter.')).toBeInTheDocument()
  })

  it('renders nothing at all when the file is clean', () => {
    const { container } = render(<ProblemsPanel issues={[]} onGoToLine={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
