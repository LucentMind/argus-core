// @vitest-environment jsdom
import { it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CitedText } from '../CitedText'

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
