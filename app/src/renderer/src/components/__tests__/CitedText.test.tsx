// @vitest-environment jsdom
import { it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CitedText } from '../CitedText'
import { clearSnippetCache } from '../../lib/snippetCache'

it('renders a citation in a user message as a clickable link and fires onCite', () => {
  const onCite = vi.fn()
  render(<CitedText text={'HI\n\n[evidence/project-pitch.md:10]'} onCite={onCite} />)
  const link = screen.getByText('evidence/project-pitch.md:10')
  expect(link.tagName).toBe('A')
  fireEvent.click(link)
  expect(onCite).toHaveBeenCalledWith('evidence/project-pitch.md', 10)
})

it('leaves plain non-citation text alone (no link)', () => {
  const { container } = render(<CitedText text="just 3*4=12" onCite={() => {}} />)
  expect(container.querySelector('a')).toBeNull()
  expect(container.textContent).toBe('just 3*4=12')
})

it('renders citations as collapsed CitationCard chips when caseSlug is set', () => {
  clearSnippetCache()
  const readSnippet = vi.fn()
  window.argus = {
    evidence: { readSnippet, onChanged: vi.fn(() => () => undefined) }
  } as never
  const onCite = vi.fn()
  render(<CitedText text={'see [evidence/app.log:12]'} onCite={onCite} caseSlug="C-1" />)
  const chip = screen.getByRole('button', { name: /app\.log:12/ })
  expect(chip.getAttribute('aria-expanded')).toBe('false')
  expect(readSnippet).not.toHaveBeenCalled()
})
