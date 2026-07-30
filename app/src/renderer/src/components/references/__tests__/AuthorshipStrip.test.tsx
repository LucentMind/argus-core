// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AuthorshipStrip } from '../AuthorshipStrip'

const authored = [
  '---',
  'name: x',
  'author: Jiawei Han <jiawiehan@gmail.com>',
  'origin: proposal',
  'contributors:',
  '  - Jiawei Han <jiawiehan@gmail.com> 2026-07-30',
  '  - Alex Chen <alex@example.test> 2026-08-02',
  '---',
  'body'
].join('\n')

describe('AuthorshipStrip', () => {
  it('names the author, explains the origin in prose, and lists dated contributors', () => {
    render(<AuthorshipStrip raw={authored} />)
    expect(screen.getByText('Jiawei Han')).toBeInTheDocument()
    expect(screen.getByText(/from an agent proposal/)).toBeInTheDocument()
    expect(screen.getByText(/Alex Chen/)).toBeInTheDocument()
    expect(screen.getByText(/2026-08-02/)).toBeInTheDocument()
  })

  it('renders nothing for a file with no author', () => {
    const { container } = render(<AuthorshipStrip raw={'---\nname: x\n---\nbody'} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('omits the origin clause when the file carries none', () => {
    render(<AuthorshipStrip raw={'---\nauthor: A B <a@x.test>\n---\nbody'} />)
    expect(screen.getByText('A B')).toBeInTheDocument()
    expect(screen.queryByText(/agent proposal|by hand|forked/)).not.toBeInTheDocument()
  })
})
