// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageView } from '../MessageView'
import { clearSnippetCache } from '../../lib/snippetCache'

const snippet = {
  ok: true,
  evidenceId: 7,
  relPath: 'evidence/app.log',
  startLine: 1,
  lines: ['first', 'second', 'third'],
  lang: null,
  eof: false
}

beforeEach(() => {
  clearSnippetCache()
  window.argus = {
    evidence: {
      readSnippet: vi.fn(async () => snippet),
      onChanged: vi.fn(() => () => undefined)
    }
  } as never
})

describe('MessageView citations', () => {
  it('renders a citation as a collapsed chip when caseSlug is set', () => {
    render(
      <MessageView markdown="crash at [evidence/app.log:2] today" onCite={vi.fn()} caseSlug="C-1" />
    )
    const chip = screen.getByRole('button', { name: /app\.log:2/ })
    expect(chip.getAttribute('aria-expanded')).toBe('false')
  })

  it('citationMode=expanded shows the snippet without a click', async () => {
    render(
      <MessageView
        markdown="crash at [evidence/app.log:2]"
        onCite={vi.fn()}
        caseSlug="C-1"
        citationMode="expanded"
      />
    )
    expect(await screen.findByText('second')).toBeTruthy()
  })

  it('emits no <p> elements, so expanded cards nest legally', () => {
    const { container } = render(
      <MessageView
        markdown={'para one [evidence/app.log:2]\n\npara two'}
        onCite={vi.fn()}
        caseSlug="C-1"
      />
    )
    expect(container.querySelector('p')).toBeNull()
    expect(container.textContent).toContain('para two')
  })

  it('falls back to plain citation links without caseSlug (ProposalsTab path)', () => {
    const onCite = vi.fn()
    render(<MessageView markdown="see [evidence/app.log:2]" onCite={onCite} />)
    const link = screen.getByRole('link', { name: 'evidence/app.log:2' })
    link.click()
    expect(onCite).toHaveBeenCalledWith({ relPath: 'evidence/app.log', start: 2, end: 2 })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('leaves external links untouched', () => {
    render(<MessageView markdown="[docs](https://example.com)" onCite={vi.fn()} caseSlug="C-1" />)
    const a = screen.getByRole('link', { name: 'docs' })
    expect(a.getAttribute('href')).toBe('https://example.com')
    expect(a.getAttribute('target')).toBe('_blank')
  })

  it('renders repo citations as chips when repoNames include the repo', () => {
    render(
      <MessageView
        markdown="see [myrepo/src/a.ts:5-7]"
        onCite={vi.fn()}
        caseSlug="C-1"
        repoNames={['myrepo']}
      />
    )
    expect(screen.getByRole('button', { name: /myrepo\/a\.ts:5-7/ })).toBeTruthy()
  })

  it('leaves repo-looking citations as text without repoNames', () => {
    render(<MessageView markdown="see [myrepo/src/a.ts:5]" onCite={vi.fn()} caseSlug="C-1" />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
