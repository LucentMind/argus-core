// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CitationCard } from '../CitationCard'
import { clearSnippetCache } from '../../lib/snippetCache'

const snippet = {
  ok: true,
  evidenceId: 7,
  relPath: 'evidence/app.log',
  startLine: 408,
  lines: ['l408', 'l409', 'l410', 'l411', 'crash here', 'l413'],
  lang: null,
  eof: false
}

let readSnippet: ReturnType<typeof vi.fn>

beforeEach(() => {
  clearSnippetCache()
  readSnippet = vi.fn(async () => snippet)
  window.argus = {
    evidence: { readSnippet, onChanged: vi.fn(() => () => undefined) }
  } as never
})

describe('CitationCard', () => {
  it('collapsed by default: renders only the chip and fetches nothing', () => {
    render(
      <CitationCard
        caseSlug="C-1"
        relPath="evidence/app.log"
        line={412}
        defaultExpanded={false}
        onOpenViewer={vi.fn()}
      />
    )
    const chip = screen.getByRole('button', { name: /app\.log:412/ })
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(readSnippet).not.toHaveBeenCalled()
  })

  it('expands on chip click: fetches once and highlights the cited line', async () => {
    render(
      <CitationCard
        caseSlug="C-1"
        relPath="evidence/app.log"
        line={412}
        defaultExpanded={false}
        onOpenViewer={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /app\.log:412/ }))
    expect(await screen.findByText('crash here')).toBeTruthy()
    expect(readSnippet).toHaveBeenCalledWith('C-1', 'evidence/app.log', 412)
    expect(readSnippet).toHaveBeenCalledTimes(1)
    const focus = screen.getByText('crash here').closest('div')
    expect(focus!.className).toContain('bg-defect/20')
  })

  it('defaultExpanded fetches on mount and can collapse via the card control', async () => {
    render(
      <CitationCard
        caseSlug="C-1"
        relPath="evidence/app.log"
        line={412}
        defaultExpanded={true}
        onOpenViewer={vi.fn()}
      />
    )
    expect(await screen.findByText('crash here')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse citation' }))
    expect(screen.queryByText('crash here')).toBeNull()
  })

  it('open-in-viewer button and snippet body click both open the viewer', async () => {
    const onOpenViewer = vi.fn()
    render(
      <CitationCard
        caseSlug="C-1"
        relPath="evidence/app.log"
        line={412}
        defaultExpanded={true}
        onOpenViewer={onOpenViewer}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Open in viewer' }))
    fireEvent.click(screen.getByText('crash here'))
    expect(onOpenViewer).toHaveBeenCalledTimes(2)
    expect(onOpenViewer).toHaveBeenCalledWith('evidence/app.log', 412)
  })

  it('renders the unavailable note on not-found without breaking the chip', async () => {
    readSnippet.mockResolvedValue({ ok: false, reason: 'not-found' })
    render(
      <CitationCard
        caseSlug="C-1"
        relPath="evidence/gone.log"
        line={9}
        defaultExpanded={true}
        onOpenViewer={vi.fn()}
      />
    )
    expect(await screen.findByText(/evidence unavailable/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /gone\.log:9/ })).toBeTruthy()
  })

  it('says so when the cited line is past the end of the file', async () => {
    readSnippet.mockResolvedValue({ ...snippet, lines: [], eof: true })
    render(
      <CitationCard
        caseSlug="C-1"
        relPath="evidence/app.log"
        line={99999}
        defaultExpanded={true}
        onOpenViewer={vi.fn()}
      />
    )
    expect(await screen.findByText(/past the end of this file/i)).toBeTruthy()
  })

  it('strips the evidence/ prefix in the chip but keeps the full relPath in the card header', async () => {
    render(
      <CitationCard
        caseSlug="C-1"
        relPath="evidence/app.log"
        line={412}
        defaultExpanded={true}
        onOpenViewer={vi.fn()}
      />
    )
    await screen.findByText('crash here')
    expect(screen.getByRole('button', { name: /^app\.log:412/ })).toBeTruthy()
    expect(screen.getByText('evidence/app.log:412')).toBeTruthy()
  })
})
