// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TextViewer } from '../TextViewer'
import type { TextDocOpenOk, TextDocSource } from '../../../../shared/textdoc'

const UTIL_TS_DOC: TextDocOpenOk = {
  ok: true,
  title: 'C-1 / evidence/util.ts',
  lang: 'typescript',
  ref: null,
  totalLines: 3,
  whole: 'const a = 1\nconst b = 2\nconst c = 3',
  caseSlug: 'C-1',
  relPath: 'evidence/util.ts',
  evidenceId: 7
}

const SMALL_DOC: TextDocOpenOk = {
  ok: true,
  title: 'NAV-1 / evidence/small.log',
  lang: null,
  ref: null,
  totalLines: 3,
  whole: 'a\nb\nc\n'
}

const LARGE_DOC: TextDocOpenOk = {
  ok: true,
  title: 'NAV-1 / evidence/big.log',
  lang: null,
  ref: null,
  totalLines: 3_000_000
}

beforeEach(() => {
  window.argus = {
    evidence: {
      list: vi.fn(async () => [])
    },
    textdoc: {
      open: vi.fn(async (source: TextDocSource) => {
        if (source.kind === 'evidence' && source.evidenceId === 1) return SMALL_DOC
        if (source.kind === 'evidence' && source.evidenceId === 2) return LARGE_DOC
        return UTIL_TS_DOC
      }),
      lines: vi.fn(async (_s: TextDocSource, from: number, to: number) => ({
        from,
        lines: Array.from({ length: to - from + 1 }, (_, i) => `big line ${from + i}`)
      })),
      search: vi.fn(async () => undefined),
      cancelSearch: vi.fn(async () => undefined),
      onSearchHits: vi.fn(() => () => {}),
      onIndexProgress: vi.fn(() => () => {})
    }
  } as never
  // jsdom has no scrollIntoView
  Element.prototype.scrollIntoView = vi.fn()
})

describe('TextViewer', () => {
  it('renders numbered lines with line-N ids and highlights the focus line', async () => {
    const { container } = render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 7 }}
        focusStart={2}
        focusEnd={2}
        onClose={vi.fn()}
      />
    )
    await screen.findByText(/util\.ts/)
    await waitFor(() => expect(container.querySelector('#line-2')).not.toBeNull())
    expect(container.querySelector('#line-2')!.className).toContain('bg-defect/20')
  })

  it('syntax-highlights code files by extension', async () => {
    const { container } = render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 7 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    await waitFor(() => expect(container.querySelector('.hljs-keyword')).not.toBeNull())
  })

  it('repo mode reads via textdoc.open and shows the ref chip', async () => {
    window.argus.textdoc.open = vi.fn(async () => ({
      ok: true,
      title: 'myrepo / src/a.ts',
      lang: 'typescript',
      ref: 'main',
      totalLines: 2,
      whole: 'const a = 1\nconst b = 2'
    })) as never
    render(
      <TextViewer
        source={{ kind: 'repo', caseSlug: 'C-1', repoName: 'myrepo', relPath: 'src/a.ts' }}
        focusStart={2}
        focusEnd={2}
        onClose={vi.fn()}
      />
    )
    expect(await screen.findByText('myrepo / src/a.ts')).toBeTruthy()
    expect(screen.getByText('@ main')).toBeTruthy()
  })

  it('repo mode shows the not-linked message', async () => {
    window.argus.textdoc.open = vi.fn(async () => ({
      ok: false,
      reason: 'repo-not-linked'
    })) as never
    render(
      <TextViewer
        source={{ kind: 'repo', caseSlug: 'C-1', repoName: 'gone', relPath: 'a.ts' }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    expect(await screen.findByText(/not linked/)).toBeTruthy()
  })

  it('small file renders whole content via HighlightedLines (legacy path)', async () => {
    render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 1 }}
        focusStart={2}
        focusEnd={2}
        onClose={vi.fn()}
      />
    )
    expect(await screen.findByText('b')).toBeInTheDocument()
  })

  it('large file renders a virtual list and shows the line count', async () => {
    render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1_500_000}
        focusEnd={1_500_002}
        onClose={vi.fn()}
      />
    )
    expect(await screen.findByText('3,000,000 lines')).toBeInTheDocument()
    // no fixed-window chip anymore
    expect(screen.queryByText(/showing lines near/)).not.toBeInTheDocument()
  })

  it('jump-to-line input scrolls the list', async () => {
    render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    const jump = await screen.findByPlaceholderText('go to line')
    await userEvent.type(jump, '2500000{Enter}')
    // the row for 2,500,000 becomes the scroll target — its id appears
    await waitFor(() => expect(document.querySelector('#line-2500000')).toBeInTheDocument())
  })
})
