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
        source={{ kind: 'evidence', caseSlug: 'C-1', relPath: 'evidence/app.log' }}
        start={412}
        end={412}
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
        source={{ kind: 'evidence', caseSlug: 'C-1', relPath: 'evidence/app.log' }}
        start={412}
        end={412}
        defaultExpanded={false}
        onOpenViewer={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /app\.log:412/ }))
    expect(await screen.findByText('crash here')).toBeTruthy()
    expect(readSnippet).toHaveBeenCalledWith('C-1', 'evidence/app.log', 412, 412)
    expect(readSnippet).toHaveBeenCalledTimes(1)
    const focus = screen.getByText('crash here').closest('div')
    expect(focus!.className).toContain('bg-defect/20')
  })

  it('defaultExpanded fetches on mount and can collapse via the card control', async () => {
    render(
      <CitationCard
        source={{ kind: 'evidence', caseSlug: 'C-1', relPath: 'evidence/app.log' }}
        start={412}
        end={412}
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
        source={{ kind: 'evidence', caseSlug: 'C-1', relPath: 'evidence/app.log' }}
        start={412}
        end={412}
        defaultExpanded={true}
        onOpenViewer={onOpenViewer}
      />
    )
    await screen.findByText('crash here')
    fireEvent.click(screen.getByLabelText('Open in viewer'))
    fireEvent.click(screen.getByText('crash here'))
    expect(onOpenViewer).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(screen.getByText('crash here').closest('[role="button"]')!, { key: 'Enter' })
    expect(onOpenViewer).toHaveBeenCalledTimes(3)
  })

  it('renders the unavailable note on not-found without breaking the chip', async () => {
    readSnippet.mockResolvedValue({ ok: false, reason: 'not-found' })
    render(
      <CitationCard
        source={{ kind: 'evidence', caseSlug: 'C-1', relPath: 'evidence/gone.log' }}
        start={9}
        end={9}
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
        source={{ kind: 'evidence', caseSlug: 'C-1', relPath: 'evidence/app.log' }}
        start={99999}
        end={99999}
        defaultExpanded={true}
        onOpenViewer={vi.fn()}
      />
    )
    expect(await screen.findByText(/past the end of this file/i)).toBeTruthy()
  })

  it('strips the evidence/ prefix in the chip but keeps the full relPath in the card header', async () => {
    render(
      <CitationCard
        source={{ kind: 'evidence', caseSlug: 'C-1', relPath: 'evidence/app.log' }}
        start={412}
        end={412}
        defaultExpanded={true}
        onOpenViewer={vi.fn()}
      />
    )
    await screen.findByText('crash here')
    expect(screen.getByRole('button', { name: /^app\.log:412/ })).toBeTruthy()
    expect(screen.getByText('evidence/app.log:412')).toBeTruthy()
  })

  it('refetches when the citation identity changes on a mounted card', async () => {
    const { rerender } = render(
      <CitationCard
        source={{ kind: 'evidence', caseSlug: 'C-1', relPath: 'evidence/app.log' }}
        start={412}
        end={412}
        defaultExpanded={true}
        onOpenViewer={vi.fn()}
      />
    )
    await screen.findByText('crash here')
    readSnippet.mockResolvedValue({ ...snippet, startLine: 508, lines: ['other line'] })
    rerender(
      <CitationCard
        source={{ kind: 'evidence', caseSlug: 'C-1', relPath: 'evidence/app.log' }}
        start={512}
        end={512}
        defaultExpanded={true}
        onOpenViewer={vi.fn()}
      />
    )
    expect(await screen.findByText('other line')).toBeTruthy()
    expect(readSnippet).toHaveBeenLastCalledWith('C-1', 'evidence/app.log', 512, 512)
  })

  it('repo citations render the repo chip label, @ref chip, and fetch via workspaces', async () => {
    const wsReadSnippet = vi.fn(async () => ({
      ok: true,
      repoName: 'myrepo',
      relPath: 'src/ui/camera.ts',
      startLine: 1545,
      lines: ['a', 'b', 'target'],
      lang: 'typescript',
      eof: false,
      truncated: false,
      ref: 'main'
    }))
    window.argus = {
      evidence: { readSnippet: vi.fn(), onChanged: vi.fn(() => () => undefined) },
      workspaces: { readSnippet: wsReadSnippet }
    } as never
    render(
      <CitationCard
        source={{ kind: 'repo', caseSlug: 'C-1', repoName: 'myrepo', relPath: 'src/ui/camera.ts' }}
        start={1547}
        end={1552}
        defaultExpanded={true}
        onOpenViewer={vi.fn()}
      />
    )
    expect(await screen.findByText('target')).toBeTruthy()
    expect(screen.getByRole('button', { name: /myrepo\/camera\.ts:1547-1552/ })).toBeTruthy()
    expect(screen.getByText('@ main')).toBeTruthy()
    expect(wsReadSnippet).toHaveBeenCalledWith('C-1', 'myrepo', 'src/ui/camera.ts', 1547, 1552)
  })

  it('repo-not-linked renders its dedicated note', async () => {
    window.argus = {
      evidence: { readSnippet: vi.fn(), onChanged: vi.fn(() => () => undefined) },
      workspaces: {
        readSnippet: vi.fn(async () => ({ ok: false, reason: 'repo-not-linked' }))
      }
    } as never
    render(
      <CitationCard
        source={{ kind: 'repo', caseSlug: 'C-1', repoName: 'gone', relPath: 'a.ts' }}
        start={1}
        end={1}
        defaultExpanded={true}
        onOpenViewer={vi.fn()}
      />
    )
    expect(await screen.findByText(/repo not linked/i)).toBeTruthy()
  })

  it('range highlight covers every cited line', async () => {
    readSnippet.mockResolvedValue({
      ...snippet,
      startLine: 408,
      lines: ['l408', 'l409', 'l410', 'l411', 'crash here', 'l413']
    })
    render(
      <CitationCard
        source={{ kind: 'evidence', caseSlug: 'C-1', relPath: 'evidence/app.log' }}
        start={410}
        end={412}
        defaultExpanded={true}
        onOpenViewer={vi.fn()}
      />
    )
    await screen.findByText('crash here')
    const highlighted = Array.from(document.querySelectorAll('pre div')).filter((d) =>
      d.className.includes('bg-defect/20')
    )
    expect(highlighted.length).toBe(3)
  })
})
