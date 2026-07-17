// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { TextViewer } from '../TextViewer'

beforeEach(() => {
  window.argus = {
    evidence: {
      read: vi.fn(async () => ({
        relPath: 'evidence/util.ts',
        caseSlug: 'C-1',
        content: 'const a = 1\nconst b = 2\nconst c = 3',
        startLine: 1,
        truncated: false
      })),
      list: vi.fn(async () => [])
    }
  } as never
  // jsdom has no scrollIntoView
  Element.prototype.scrollIntoView = vi.fn()
})

describe('TextViewer', () => {
  it('renders numbered lines with line-N ids and highlights the focus line', async () => {
    const { container } = render(<TextViewer evidenceId={7} focusLine={2} onClose={vi.fn()} />)
    await screen.findByText(/util\.ts/)
    await waitFor(() => expect(container.querySelector('#line-2')).not.toBeNull())
    expect(container.querySelector('#line-2')!.className).toContain('bg-defect/20')
  })

  it('syntax-highlights code files by extension', async () => {
    const { container } = render(<TextViewer evidenceId={7} focusLine={1} onClose={vi.fn()} />)
    await waitFor(() => expect(container.querySelector('.hljs-keyword')).not.toBeNull())
  })
})
